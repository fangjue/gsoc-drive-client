from google.appengine.ext import ndb
class RelayChannel(ndb.Model):
  gcmChannelId = ndb.StringProperty()
  token = ndb.StringProperty()
  expiration = ndb.DateTimeProperty()
  # The most significant two bits represent the status and the remaining bits
  # represent the largest change id.
  changeIdAndStatus = ndb.IntegerProperty()

STATUS_SHIFT = 62
# The relay channel is created but the first sync notification from Drive API
# has not yet been received.
STATUS_CREATED = 0
# The sync notification from Drive API has been received and the channel is
# ready.
STATUS_READY = 1
# A change notification has been received and relayed to the client. Further
# notifications will be ignored until the client finishes processing these
# changes and is ready to receive notifications again.
STATUS_PENDING = 2

STATUS_MASK = 3
CHANGE_ID_SHIFT = 2
