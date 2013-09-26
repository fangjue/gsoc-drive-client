/**
 * @fileoverview Client side of https://gsoc-drive-client.appspot.com/. See
 * ../gae/ for server side code.
 */

/** @const */ var PUSH_NOTIFICATION_SERVER =
    'https://gsoc-drive-client.appspot.com';
/** @const */ var PUSH_NOTIFICATION_BIND_URL = PUSH_NOTIFICATION_SERVER +
    '/bind';
/** @const */ var PUSH_NOTIFICATION_STATUS_URL = PUSH_NOTIFICATION_SERVER +
    '/status';
/** @const */ var PUSH_MESSAGING_SUB_CHANNEL = 0;
/** @const */ var CHANNEL_OVERLAP_TIME = 1000 * 60 * 5;
/** @const */ var CHANNEL_RENEW_ALARM_NAME = 'pushRenew';
/** @const */ var CHANNEL_ID_PROPERTY_FILE_ID = 'root';
/** @const */ var CHANNEL_ID_PROPERTY_PREFIX = 'gcmChannel_';
// Should be consistent with ../gae/handler.py
/** @const */ var CHANNEL_TIME_SEPARATOR = '|';

log.registerSource('PushNotificationHandler');

/**
 * @constructor
 */
function PushNotificationHandler(drive) {
  this.requestSender_ = new RequestSender();
  this.drive_ = drive;
  return this;
}

/**
 * chrome.pushMessaging.onMessage handler.
 * @param {Object} message
 */
PushNotificationHandler.prototype.onMessage = function(message) {
  if (message.subchannelId == PUSH_MESSAGING_SUB_CHANNEL) {
    console.log('PUSH: ', message);
  } else {
    log.PushNotificationHandler.warn(
        'Received a message from an unknown subchannel.', message);
  }
};

/**
 * Bind the Drive account with the GCM channel.
 * @param {string} largestChangeId Largest change id known by the client.
 *     Notifications with smaller ids will be ignored.
 * @param {function} callback
 */
PushNotificationHandler.prototype.bind = function(largestChangeId, callback) {
  chrome.storage.local.get([
    storageKeys.settings.clientId,
    storageKeys.pushNotifications.channelId,
    storageKeys.pushNotifications.expiration
  ], function(items) {
    var clientId = items[storageKeys.settings.clientId];
    var channelId = items[storageKeys.pushNotifications.channelId];
    var expiration = items[storageKeys.pushNotifications.expiration];

    if (!clientId) {
      log.PushNotificationHandler.error(
          'NOTREACHED: Client ID is not defined.');
      callback(null);
      return;
    }

    if (this.isChannelAlive_(expiration))
      this.renewChannel_(channelId, largestChangeId, callback);
    else
      this.establishChannel_(clientId, largestChangeId, callback);
  }.bind(this));
};

/**
 * Compare the expiration of the channel with Date.now() and determine if the
 * channel is considered 'alive'.
 * @param {long} expiration The number of milliseconds since Unix epoch,
 *     indicating when the channel will be expired.
 */
PushNotificationHandler.prototype.isChannelAlive_ = function(expiration) {
  return expiration - Date.now() > CHANNEL_OVERLAP_TIME;
};

PushNotificationHandler.prototype.isChannelExpired = function(expiration) {
  return expiration > Date.now();
};

/**
 * Establish a new channel.
 * @param {string} clientId The client ID.
 * @param {string} largestChangeId
 * @param {function} callback
 */
PushNotificationHandler.prototype.establishChannel_ = function(clientId,
    largestChangeId, callback) {
  chrome.pushMessaging.getChannelId(false, function(details) {
    if (details && details.channelId) {
      this.drive_.setProperty(CHANNEL_ID_PROPERTY_FILE_ID,
          CHANNEL_ID_PROPERTY_PREFIX + clientId, false,
          details.channelId + CHANNEL_TIME_SEPARATOR + Date.now(),
          function(details, error) {
        if (!details)
          callback(null, error);
        else {
          chrome.identity.getAuthToken({interactive: false}, function(token) {
            if (!token) {
              callback(null, {tokenError: chrome.runtime.lastError});
              return;
            }
            this.sendBindRequest_(clientId, largestChangeId, token, callback);
          }.bind(this));
        }
      }.bind(this));
    } else
      callback(null, {tokenError: chrome.runtime.lastError});
  }.bind(this));
};

PushNotificationHandler.prototype.sendBindRequest_ = function(clientId, largestChangeId, token, callback) {
  this.requestSender_.sendRequest('POST', PUSH_NOTIFICATION_BIND_URL, {
    body: {
      clientId: clientId,
      largestChangeId: largestChangeId,
    },
    authorization: 'Bearer ' + token,
  }, function(xhr, error) {
    if (error)
      callback(null, error);
    else {
      var response;
      try {
        response = JSON.parse(xhr.responseText);
      } catch (e) {
        callback(null);
        return;
      }
      if (!response.channelId || !response.expiration) {
        callback(null);
        return;
      }
      var items = {};
      items[storageKeys.pushNotifications.channelId] = response.channelId;
      items[storageKeys.pushNotifications.expiration] = response.expiration;
      chrome.storage.local.set(items, function() {
        chrome.alarms.create(CHANNEL_RENEW_ALARM_NAME,
            {when: response.expiration - CHANNEL_OVERLAP_TIME});
        callback(response.channelId);
      });
    }
  });
};

PushNotificationHandler.prototype.renewChannel_ = function(channelId,
    largestChangeId, callback) {
  this.requestSender_.sendRequest('POST', PUSH_NOTIFICATION_BIND_URL, {
    body: {
      channelId: channelId,
      largestChangeId: largestChangeId,
    },
  }, function(xhr, error) {
    if (error)
      callback(null, error);
    else if (xhr.status == 200)
      callback(channelId, {largestChangeId: xhr.responseText});
    else
      callback(channelId);
  });
};
