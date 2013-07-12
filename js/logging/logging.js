/**
 * @fileoverview A simple library for logging and metrics services.
 */

'use strict'

var log = {
  severities: []
};

(function() {
  // A large initial value is used to avoid log entry overwrite before
  // initialization is finished.
  var UNINITIALIZED_ID = 3221225472;
  var STORAGE_PREFIX = 'logging.';
  var STORAGE_CURRENT_ID = STORAGE_PREFIX + 'currentId';
  var currentId = UNINITIALIZED_ID;

  /**
   * Initialize the logging services.
   * @param {function} opt_callback Called when the initialization is completed.
   */
  log.init = function(opt_callback) {
    console.assert(currentId >= UNINITIALIZED_ID);
    storageGetItem('local', STORAGE_CURRENT_ID, function(id) {
      currentId = id || 0;
      if (opt_callback)
        opt_callback();
    });
  };

  /**
   * Create a log entry.
   * @param {string} severity The severity of the entry.
   * @param {string} source The source of the entry.
   * @param {any} messages The messages to log. You can specify one or more
   *     messages. Messages must be JSON-serializable values.
   */
  function createEntry(severity, source, messages, var_args) {
    console.assert(currentId < UNINITIALIZED_ID,
                   'The logging service is not properly initialized.');
    messages = Array.prototype.slice.call(arguments, 2);
    ++currentId;
    
    var items = {};
    var logEntry = {
      time: (new Date()).getTime(),
      severity: severity,
      messages: messages,
    };
    if (source)
      logEntry.source = source;

    if (currentId < UNINITIALIZED_ID)
      items[STORAGE_CURRENT_ID] = currentId;
    items[STORAGE_PREFIX + currentId.toString()] = logEntry;
    chrome.storage.local.set(items);
  };

  log.severities = ['error', 'warning', 'info', 'debug'];

  log.register = function(severity, source, base_) {
    if (base_)
      base_[severity] = createEntry.bind(severity, source);
    else if (source) {
      if (!log[source])
        log[source] = {};
      log.register(severity, source, log[source]);
    } else {
      log[severity] = createEntry.bind(null, severity, '');
      if (log.severities.indexOf(severity) == -1)
        log.severities.push(severity);
    }
  };

  log.registerSource = function(source) {
    log.severities.forEach(function(severity) {
      log.register(severity, source);
    });
  };

  log.registerSource('');
})();
