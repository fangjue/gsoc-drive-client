import base64
import json
import logging
import re
import urllib
import webapp2
from datetime import datetime, timedelta
from Crypto.Random import random
from google.appengine.api import app_identity, urlfetch
from channels import Channels
import models
from push_messaging import PushMessagingService

# Note that base64-encoded channel id cannot be longer than 64 characters.
_CHANNEL_ID_BITS = 256
# math.ceil(256.0 / 8 / 3) * 4 = 44 and the trailing '=' is stripped.
_CHANNEL_ID_REGEX = r'^[0-9a-zA-Z-_]{43}$'
# Note that base64-encoded token cannot be longer than 256 characters.
_CHANNEL_TOKEN_BITS = 1024
# math.ceil(1024.0 / 8 / 3) * 4 = 172
_CHANNEL_TOKEN_REGEX = r'^[0-9a-zA-Z-_]{171}=$'

_MAX_REQUEST_BODY_LEN = 256

# Must be consistent with generateClientId() in /js/bg.js
_CLIENT_ID_REGEX = r'^[0-9a-zA-Z_]{32}$'
# Requested time-to-live for channels, in seconds.
_CHANNEL_TTL = 60 * 60 * 2
_PROPERTY_BASE_URL = 'https://www.googleapis.com/drive/v2/files/root/properties/gcmChannel_'
_PROPERTY_REQUEST_PARAMETER = '?visibility=PRIVATE&fields=value'
_CHANGES_WATCH_URL = 'https://www.googleapis.com/drive/v2/changes/watch?prettyPrint=false'
_DRIVE_API_WATCH_TYPE = 'web_hook'
# changes.watch requests are generally slow.
_DRIVE_API_REQUEST_DEADLINE = 25
_UNSYNCED_CHANNEL_TTL = timedelta(minutes=5)

# According to https://developers.google.com/drive/push#msg-format, request
# body for change notifications is very small and 256 should be enough.
_DRIVE_KIND_CHANGE = 'drive#change'
_GOOG_RESOURCE_STATE_SYNC = 'sync'
_GOOG_RESOURCE_STATE_CHANGE = 'change'

class NotificationsHandler(webapp2.RequestHandler):
  def post(self):
    # There's no point setting the appropriate status code for fatal errors.
    self.response.status = 200

    channelId, token, state = (self.request.headers.get(name) for name in
        ['X-Goog-Channel-ID', 'X-Goog-Channel-Token', 'X-Goog-Resource-State'])

    largestChangeId = None

    # Sanity checks.
    if channelId is None or token is None:
      return
    if not all((re.match(_CHANNEL_ID_REGEX, channelId),
                re.match(_CHANNEL_TOKEN_REGEX, token))):
      return

    if state == _GOOG_RESOURCE_STATE_SYNC:
      synced, gcmChannel = Channels.Sync(channelId, token)
      if synced:
        svc = PushMessagingService()
        svc.SendMessage(gcmChannel, 0, json.dumps({
          'channelId': channelId,
          'sync': True,
        }))

    elif state == _GOOG_RESOURCE_STATE_CHANGE:
      # Check request body and extract the change id if any.
      if self.request.body:
        if len(self.request.body) > _MAX_REQUEST_BODY_LEN:
          return
        try:
          body = json.loads(self.request.body)
          if body.get('kind') != _DRIVE_KIND_CHANGE:
            return
          largestChangeId = int(body.get('id'))
        except ValueError:
          return
      logging.info('largestChangeId: %s' % largestChangeId)
      sendMessage, gcmChannel = Channels.UpdateChangeId(channelId, token,
          largestChangeId)
      if sendMessage:
        svc = PushMessagingService()
        svc.SendMessage(gcmChannel, 0, json.dumps({
          'largestChangeId': largestChangeId,
          'channelId': channelId,
        }))

# POST /bind
# Authorization: Bearer ...
# Content-Type: application/json
# Origin: chrome-extension://bjajfhkjlejiflopbocmfjijlomojaof
# User-Agent: ...
#
# {
#   "channelId": ..., // Optional, only used for subsequent binds.
#   "clientId": ..., // Optional, only used for the first bind.
#   "largestChangeId": "1234", // Required. Current known largest change id.
# }
#
# HTTP 200 OK
# {
#   "channelId": ..., // Optional, only returned for the first bind.
#   "expiration": ..., // Optional, only returned for the first bind.
# }
class BindHandler(webapp2.RequestHandler):
  def _getRandomBinaryString(self, bits):
    randomNumber = random.getrandbits(bits)
    binaryString = ''
    while len(binaryString) < bits / 8:
      binaryString = chr(randomNumber & 0xff) + binaryString
      randomNumber = randomNumber >> 8
    return binaryString

  def post(self):
    self.response.headers['Content-Type'] = 'text/plain'
    if len(self.request.body) > _MAX_REQUEST_BODY_LEN:
      self.response.status = 413
      return

    request = None
    try:
      request = json.loads(self.request.body)
    except ValueError:
      self.response.status = 400
      self.response.write('Invalid JSON.')
      return

    clientId, channelId, largestChangeId = (request.get(key) for key in [
        'clientId', 'channelId', 'largestChangeId'])
    if largestChangeId is None or not isinstance(largestChangeId, basestring):
      self.response.status = 400
      self.response.write('Required field missing.')
      return

    try:
      largestChangeId = int(largestChangeId)
    except ValueError:
      self.response.status = 400
      self.response.write('Invalid largest change ID.')
      return

    if clientId is not None:
      # First bind.
      # Authorization is required.
      if self.request.headers.get('Authorization') is None:
        self.response.status = 401
        return

      if re.match(_CLIENT_ID_REGEX, clientId) is None:
        self.response.status = 400
        self.response.write('Invalid client ID.')
        return

      self._createChannel(clientId, largestChangeId)

    elif channelId is not None:
      # Subsequent binds to resume the channel.
      self._refreshChannel(channelId, largestChangeId)
      
    else:
      self.response.status = 400
      self.response.write('Invalid fields specified.')

  def _createChannel(self, clientId, largestChangeId):
    propertyRequest = self._sendGetPropertyRequest(clientId)
    channelId, token = self._generateChannelIdAndToken()
    gcmChannel = self._parseGetPropertyResponse(propertyRequest)
    if gcmChannel is None:
      return

    Channels.Add(channelId,
                 token,
                 gcmChannel,
                 datetime.now() + _UNSYNCED_CHANNEL_TTL,
                 largestChangeId)

    watchRequest = self._sendWatchRequest(channelId, token)
    try:
      result = watchRequest.get_result()
    except urlfetch.Error:
      self.response.status = 500
      self.response.write('Network error.')
      return
    if result.status_code == 200:
      try:
        response = json.loads(result.content)
      except ValueError:
        logging.warning('Drive API changes.watch respond with 200 but ' +
            'the body is not valid JSON')
        self.response.status = 500
        self.response.write('API server error.')
        return
      
      try:
        Channels.UpdateExpiration(channelId, datetime.fromtimestamp(
            int(response.get('expiration')) / 1000.0))
      except ValueError:
        logging.warning('Drive API changes.watch\'s response resulted in ' +
            'ValueError: %s' % result.content)
        self.response.status = 500
        self.response.write('API server error.')
        return

      self.response.headers['Content-Type'] = 'application/json'
      self.response.write(json.dumps({
        'channelId': channelId,
        'expiration': response.get('expiration'),
      }))
    else:
      self.response.status = 500
      self.response.write('API request failed with %s.\n' % result.status_code)
      self.response.write(result.content)

  def _sendGetPropertyRequest(self, clientId):
    return self._sendRequest('GET', _PROPERTY_BASE_URL +
        urllib.quote(clientId) + _PROPERTY_REQUEST_PARAMETER)

  def _parseGetPropertyResponse(self, propertyRequest):
    try:
      result = propertyRequest.get_result()
    except urlfetch.Error:
      self.response.status = 500
      self.response.write('Network error.')
      return None

    if result.status_code == 200:
      try:
        response = json.loads(result.content)
      except ValueError:
        logging.warning('Drive API succeeded but returned invalid JSON.')
        self.response.status = 500
        self.response.write('API server error.')
        return None
      gcmChannel = response.get('value')
      if not self._isValidGcmChannelId(gcmChannel):
        self.response.status = 400
        self.response.write('Invalid GCM channel id.')
        return None
      return gcmChannel

    if result.status_code == 401:
      self.response.status = 401
    else:
      self.response.status = 404
    self.response.write('Drive API properties.get failed with %s.' %
        result.status_code)
    self.response.write(result.content)
    return None

  def _isValidGcmChannelId(self, channelId):
    # See also https://code.google.com/p/chromium/codesearch#chromium/src/chrome/browser/extensions/api/push_messaging/push_messaging_api.cc&sq=package:chromium&type=cs&rcl=1379309038&l=220
    # for how the channel id is generated. It should be something like
    # <Obsfucated GAIA ID>/<Extension ID>
    # Extension ids contain only a-p and the length is 32. See also
    # https://code.google.com/p/chromium/codesearch#chromium/src/extensions/common/id_util.cc&sq=package:chromium&type=cs&rcl=1379309038&l=15.
    return (channelId is not None and
        isinstance(channelId, basestring) and
        re.match('\d{1,40}/[a-p]{32}', channelId))

  def _generateChannelIdAndToken(self):
    # Channel ids for Drive API's watch requests can only contain digits,
    # alphabets and '-'.
    channelId = base64.urlsafe_b64encode(
        self._getRandomBinaryString(_CHANNEL_ID_BITS)).strip('=')

    # URL-safe characters are all acceptable in token.
    token = base64.urlsafe_b64encode(
        self._getRandomBinaryString(_CHANNEL_TOKEN_BITS))

    return channelId, token

  def _sendWatchRequest(self, channelId, token):
    return self._sendRequest('POST', _CHANGES_WATCH_URL, {
      'id': channelId,
      'token': token,
      'type': _DRIVE_API_WATCH_TYPE,
      'address': 'https://' + app_identity.get_default_version_hostname() +
                 '/notify',
      'params': {
        'ttl': _CHANNEL_TTL,
      }
    })

  def _refreshChannel(self, channelId, largestChangeId):
    self.response.status = 200
    result = Channels.Renew(channelId, largestChangeId)
    if result == True:
      self.response.write('Renewed!')
    else:
      self.response.write(result or '')

  def _sendRequest(self, method, url, body=None):
    rpc = urlfetch.create_rpc(deadline=_DRIVE_API_REQUEST_DEADLINE)
    headers = {}
    for header in ['Authorization', 'User-Agent']:
      headers[header] = self.request.headers.get(header)
    userip = 'userip=' + urllib.quote_plus(self.request.remote_addr)
    if '?' in url:
      url += '&' + userip
    else:
      url += '?' + userip
    if body is not None:
      body = json.dumps(body)
      headers['Content-Type'] = 'application/json'
    urlfetch.make_fetch_call(rpc, url, payload=body, method=method,
        headers=headers)
    return rpc

# GET /status
#
# <channelId>
#
# created|ready|suspended
# created: The notification channel is established (Drive API's watch
#     request succeeded).
# ready: The first 'sync' notification for the channel is received and it's
#     to receive change notifications.
# suspended: A notification has been received and forwarded. The client will
#     examine the change and take actions appropriately, probably making
#     further changes. Any further notifications received are no longer
#     forwarded until another bind request is sent.
class StatusHandler(webapp2.RequestHandler):
  def get(self):
    channelId = self.request.body
    if not re.match(_CHANNEL_ID_REGEX, channelId):
      self.response.status = 404
      return

    status = Channels.GetStatus(channelId)
    self.response.status = 200
    if status == models.STATUS_READY:
      self.response.write('ready')
    elif status == models.STATUS_PENDING:
      self.response.write('pending')
    elif status == models.STATUS_CREATED:
      self.response.write('created')
    else:
      self.response.status = 404

class TestHandler(webapp2.RequestHandler):
  def get(self):
    pass

class CronHandler(webapp2.RequestHandler):
  def get(self):
    self.response.status = 200
    logging.info('Cron job: Removed %s expired channel(s).' %
        Channels.Cleanup())

app = webapp2.WSGIApplication([
  (r'/notify', NotificationsHandler),
  (r'/bind', BindHandler),
  (r'/status', StatusHandler),
  (r'/test', TestHandler),
  (r'/cron', CronHandler),
])
