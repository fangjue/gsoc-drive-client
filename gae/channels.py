from datetime import datetime
import models
from google.appengine.ext import ndb

class Channels(object):
  @staticmethod
  def Add(driveChannelId, token, gcmChannelId, expiration, largestChangeId):
    channel = models.RelayChannel(
        key=ndb.Key(models.RelayChannel, driveChannelId),
        gcmChannelId = gcmChannelId,
        token = token,
        expiration = expiration,
        changeIdAndStatus = ((largestChangeId << models.CHANGE_ID_SHIFT) |
                                                 models.STATUS_CREATED))
    channel.put()

  @staticmethod
  def _Get(driveChannelId, tokenToVerify=None):
    channel = ndb.Key(models.RelayChannel, driveChannelId).get()
    if channel is None:
      return None
    if tokenToVerify is not None and channel.token != tokenToVerify:
      return None
    return channel

  @staticmethod
  def UpdateExpiration(driveChannelId, expiration):
    channel = Channels._Get(driveChannelId)
    if channel is None:
      return False
    channel.expiration = expiration
    channel.put()
    return True

  @staticmethod
  def Sync(driveChannelId, token):
    channel = Channels._Get(driveChannelId, token)
    if channel is None:
      return (False, None)
    if channel.changeIdAndStatus & models.STATUS_MASK == models.STATUS_CREATED:
      channel.changeIdAndStatus = (channel.changeIdAndStatus &
          ~models.STATUS_MASK | models.STATUS_READY)
      channel.put()
      return (True, channel.gcmChannelId)
    return (False, None)

  @staticmethod
  def UpdateChangeId(driveChannelId, token, largestChangeId):
    channel = Channels._Get(driveChannelId, token)
    if channel is None:
      return (False, None)
    if channel.changeIdAndStatus >> models.CHANGE_ID_SHIFT < largestChangeId:
      result = (channel.changeIdAndStatus & models.STATUS_MASK ==
          models.STATUS_READY)
      channel.changeIdAndStatus = (largestChangeId <<
          models.CHANGE_ID_SHIFT) | models.STATUS_PENDING
      channel.put()
      return (result, channel.gcmChannelId)
    return (False, None)

  @staticmethod
  def Renew(driveChannelId, largestChangeId):
    channel = Channels._Get(driveChannelId)
    if channel is None:
      return None
    if channel.changeIdAndStatus >> models.CHANGE_ID_SHIFT <= largestChangeId:
      channel.changeIdAndStatus = (largestChangeId << models.CHANGE_ID_SHIFT
          ) | models.STATUS_READY
      channel.put()
      return True
    return channel.changeIdAndStatus >> models.CHANGE_ID_SHIFT

  @staticmethod
  def GetStatus(driveChannelId):
    channel = Channels._Get(driveChannelId)
    if channel is None:
      return None
    return channel.changeIdAndStatus & models.CHANGE_ID_MASK

  @staticmethod
  def Remove(driveChannelId):
    ndb.Key(models.RelayChannel, driveChannelId).delete()

  @staticmethod
  def Cleanup():
    keys = [key for key in
        models.RelayChannel.query(models.RelayChannel.expiration <
        datetime.now()).iter(keys_only = True, limit = 100)]
    ndb.delete_multi(keys)
    return len(keys)
