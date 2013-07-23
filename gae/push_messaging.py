import json
import logging
import urllib
from google.appengine.api import urlfetch
from value_store import ValueStore

_CLIENT_ID = None
_CLIENT_SECRET = None
_REFRESH_TOKEN = None

_OAUTH_TOKEN_URL = 'https://accounts.google.com//o/oauth2/token'
_PUSH_MESSAGE_URL = 'https://www.googleapis.com/gcm_for_chrome/v1/messages'

class PushMessagingService(object):
  def __init__(self):
    self._value_store = ValueStore('PushMessagingToken', False)
    self._access_token = None
  
  def _RenewAccessToken(self):
    client_id, client_secret, refresh_token = _CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN
    if _CLIENT_ID:
      self._value_store.Set('ClientId', _CLIENT_ID)
      self._value_store.Set('ClientSecret', _CLIENT_SECRET)
      self._value_store.Set('RefreshToken', _REFRESH_TOKEN)
    else:
      client_id, client_secret, refresh_token = self._value_store.Get('ClientId'), self._value_store.Get('ClientSecret'), self._value_store.Get('RefreshToken')

    if not client_id or not client_secret or not refresh_token:
      logging.error('Failed to get client ID.')
      return None

    result = urlfetch.fetch(url=_OAUTH_TOKEN_URL,
                            payload=urllib.urlencode({
                              'client_id': client_id,
                              'client_secret': client_secret,
                              'refresh_token': refresh_token,
                              'grant_type': 'refresh_token',
                            }),
                            method='POST',
                            headers={
                              'Content-Type': 'application/x-www-form-urlencoded'
                            })
    if result.status_code != 200:
      logging.error('Failed to get the access token. Status: %s. Response: %s' %
                    (result.status_code, result.content))
      return None

    result_json = json.loads(result.content)
    access_token = result_json.get('access_token')
    if access_token:
      self._value_store.Set('AccessToken', access_token)
      self._access_token = access_token
    return access_token

  def _GetAccessToken(self):
    if self._access_token:
      return self._access_token

    self._access_token = self._value_store.Get('AccessToken')
    if self._access_token:
      return self._access_token

    return self._RenewAccessToken()

  def SendMessage(self, channelId, subchannelId=0, payload=''):
    if self._SendMessageInternal(channelId, subchannelId, payload) == 403:
      self._RenewAccessToken()
      self._SendMessageInternal(channelId, subchannelId, payload)

  def _SendMessageInternal(self, channelId, subchannelId, payload):
    result = urlfetch.fetch(url=_PUSH_MESSAGE_URL,
                            payload=json.dumps({
                              'channelId': channelId,
                              'subchannelId': subchannelId,
                              'payload': payload,
                            }),
                            method='POST',
                            headers={
                              'Content-Type': 'application/json',
                              'Authorization': 'Bearer ' + self._GetAccessToken(),
                            })
    if result.status_code != 200:
      logging.warning('Push messaging failed with status %s and response %s' %
                      (result.status_code, result.content))
    return result.status_code
