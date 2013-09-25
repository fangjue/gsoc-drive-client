'use strict';

/** @const */ var SCAN_LOCAL_ALARM_NAME = 'local';
/** @const */ var SCAN_REMOTE_ALARM_NAME = 'remote';

var systemInfo = {};
var localRootEntry = null;
var internalFs = null;
var internalDirectories = {};
var clientId = null;
var initDone = false;
var onInit = null;
var engine = null;

// Initialization.
asyncCallEvery([
  // Get platform information.
  function(done) {
    chrome.runtime.getPlatformInfo(function(platformInfo) {
      systemInfo = platformInfo;
      done();
    });
  },
  // Get memory information if available.
  function(done) {
    if (chrome.system && chrome.system.memory) {
      chrome.system.memory.getInfo(function(memoryInfo) {
        systemInfo.memoryCapacity = memoryInfo.capacity;
        done();
      });
    } else
      done();
  },
  // Get local root entry.
  function(done) {
    storageGetItem('local', storageKeys.settings.rootEntryId, function(id) {
      if (id) {
        chrome.fileSystem.restoreEntry(id, function(entry) {
          localRootEntry = entry;
          done();
        });
      } else {
        console.warn('INIT: No local root entry.');
        done();
      }
    });
  },
  // Internal FS initialization.
  function(done) {
    (navigator.persistentStorage || navigator.webkitPersistentStorage).
        requestQuota(30 * 1024 * 1024 * 1024, function(grantedBytes) {
      (window.requestFileSystem || window.webkitRequestFileSystem)(
          PERSISTENT, grantedBytes, function(fs) {
        internalFs = fs;
        asyncEvery1(['log', 'tmp'], function(name, callback) {
          internalFs.root.getDirectory(name, {create: true, exclusive: false},
              function(entry) {
            internalDirectories[name] = entry;
            if (name == 'log') {
              log.init({directoryEntry: internalDirectories['log']},
                  function(err) {
                if (err)
                  console.error('INIT: Logging service failed to initialize.',
                      err);
                callback();
              });
            } else
              callback();
          }, function(err) {
            console.error('INIT: Failed to open directory from the internal fs',
                name, err);
            callback();
          });
        }, function() {
          done();
        });
      }, function(err) {
        console.error('INIT: Request for internal file system is denied.', er);
        done();
      });
    }, function(err) {
      console.error('INIT: Quota request for internal file system is denied.',
          err);
      done();
    });
  },
], function() {
  console.log('INIT: Done.');
  if (localRootEntry) {
    engine = new SyncEngine(localRootEntry);
    engine.init(function(error) {
      if (error) {
        console.log('INIT: SyncEngine failed to initialze.');
        engine = null;
      }
      initDone = true;
      if (onInit)
        onInit();
    });
  } else {
    // ...
    initDone = true;
    if (onInit)
      onInit();
  }
});

function generateClientId() {
  /** @const */ var CLIENT_ID_LENGTH = 24;
  var bytes = new Uint8Array(CLIENT_ID_LENGTH);
  window.crypto.getRandomValues(bytes);
  return btoa(Array.prototype.map.call(bytes, function(ch) {
    return String.fromCharCode(ch);
  }).join('')).replace(/\+|=/g, '_');
}

chrome.runtime.onStartup.addListener(function() {
});

chrome.runtime.onInstalled.addListener(function() {
  chrome.alarms.create(SCAN_LOCAL_ALARM_NAME, {periodInMinutes: 1});
  storageGetItem('local', storageKeys.settings.clientId, function(value) {
    if (!value) {
      // First run
      clientId = generateClientId();
      storageSetItem('local', clientIdKey, clientId, function() {
        if (!chrome.runtime.lastError)
          chrome.app.window.create('welcome.html');
      });
    }
  });
});

/**
 * Wrap an event listener to make sure it's called after the initialization is
 * done if the event page is just brought up.
 * @param {function} callback An event listener.
 * @param {function} opt_hook An optional hook function that will be called
 *     before calling |callback|. If it returns true, |callback| will not be
 *     called. It can be used to handle some events that does not need
 *     initialization. See the app.runtime.onLaunched event listener below
 *     for an example.
 */
function wrapListener(callback, opt_hook) {
  return function() {
    if (opt_hook && opt_hook.apply(null, arguments))
      return;
    if (initDone)
      callback.apply(this, arguments);
    else {
      onInit = Function.prototype.bind.apply(callback, [this].concat(
          Array.prototype.slice.call(arguments, 0)));
    }
  };
}

chrome.app.runtime.onLaunched.addListener(wrapListener(function(launchData) {
  if (!localRootEntry)
    chrome.app.window.create('welcome.html');
}, function(launchData) {
  // The file handler simply opens the online document in the browser so it
  // does not need any initialization.
  // launchData.id should be consistent with the file handler in manifest.json.
  if (launchData && launchData.id == 'gdoc') {
    (new FileHandler(launchData.items)).handle();
    return true;
  }
}));

chrome.alarms.onAlarm.addListener(wrapListener(function(alarm) {
  if (!engine || !engine.isIdle()) 
    return;
  if (alarm.name == SCAN_LOCAL_ALARM_NAME)
    engine.scanFiles({local: true});
  else if (alarm.name == SCAN_REMOTE_ALARM_NAME)
    engine.scanFiles({remote: true});
}));

chrome.pushMessaging.onMessage.addListener(wrapListener(function(message) {
  if (engine)
    engine.pushNotificationHandler.onMessage(message);
}));
