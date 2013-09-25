/** @const */ var PUSH_NOTIFICATION_SERVER =
    'https://gsoc-drive-client.appspot.com';
/** @const */ var PUSH_NOTIFICATION_BIND_URL = PUSH_NOTIFICATION_SERVER +
    '/bind';
/** @const */ var PUSH_NOTIFICATION_STATUS_URL = PUSH_NOTIFICATION_SERVER +
    '/status';
/** @const */ var PUSH_MESSAGING_SUB_CHANNEL = 0;

log.registerSource('PushNotificationHandler');

function PushNotificationHandler() {
  this.requestSender_ = new RequestSender();
  return this;
}

PushNotificationHandler.prototype.onMessage = function(message) {
  if (message.subchannelId == PUSH_MESSAGING_SUB_CHANNEL) {
  } else {
    log.PushNotificationHandler.warning(
        'Received a message from an unknown subchannel.', message);
  }
};

PushNotificationHandler.prototype.bind = function(largestChangeId, callback) {
  storageGetItem('local', storageKeys.settings.clientId, function(clientId) {
    if (!clientId) {
      callback(null);
      return;
    }

    this.requestSender_.sendRequest('POST', PUSH_NOTIFICATION_BIND_URL, {
      body: {
        clientId: clientId
      },
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
      }
    });
  });
};
