/**
 * @fileoverview A simple library for logging and metrics services.
 */

'use strict'

var log = {
  severities: []
};

(function() {
  var logRootEntry = null;
  var logFileEntry = null;
  var logFileWriter = null;
  var pendingLogs = [];

  /**
   * Initialize the logging services.
   * @param {Object} storage
   * @param {function} callback Called when the initialization is completed.
   */
  log.init = function(storage, callback) {
    logRootEntry = storage.directoryEntry;
    logFileEntry = logRootEntry.getFile('current.log', {create: true},
        function(entry) {
      logFileEntry = entry;
      logFileEntry.createWriter(function(writer) {
        logFileWriter = writer;
        writer.onwriteend = writePendingLogs;
        writer.onerror = function() {
          console.error('LOG: Failed to write to the log file.', writer.error);
        };
        writer.seek(writer.length);
        callback();
      }, function(err) {
        callback(err);
      });
    }, function(err) {
      callback(err);
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
    console.assert(logFileWriter,
        'The logging service is not properly initialized.');
    messages = Array.prototype.slice.call(arguments, 2);
    
    var items = {};
    var logEntry = {
      time: (new Date()).getTime(),
      severity: severity,
      messages: messages,
      stack: (new Error()).stack,
    };
    if (source)
      logEntry.source = source;

    writeLogEntries([logEntry]);
  }

  /**
   * Write log entries into the log file.
   * @param {Array.LogEntry} entries Entries to write. Nothing is written if
   *     it's an empty array.
   */
  function writeLogEntries(entries) {
    if (entries.length == 0)
      return;

    if (logFileWriter.readyState == logFileWriter.WRITING) {
      pendingLogs = pendingLogs.concat(entries);
      return;
    }

    var logText = '';
    entries.forEach(function(entry) {
      logText += formatEntryAsText(entry);
    });
    logFileWriter.write(new Blob([logText]));
  }

  /**
   * Write pending log entries (new log entries created while a previous
   * writing is in progress).
   */
  function writePendingLogs() {
    console.assert(logFileWriter.readyState != logFileWriter.WRITING);
    var logsToWrite = pendingLogs;
    pendingLogs = [];
    writeLogEntries(logsToWrite);
  }

  /**
   * Format a LogEntry object into text so that it can be written into the
   * log file.
   * @param {LogEntry} logEntry
   * @returns {string} Text representation of the log entry.
   */
  function formatEntryAsText(logEntry) {
    var result = '[' + (new Date(logEntry.time)).toLocaleString() + ']';
    if (logEntry.source)
      result += ' [' + logEntry.source + ']';
    result += ' ' + logEntry.severity.toUpperCase() + ':';
    logEntry.messages.forEach(function(message) {
      result += ' ' + JSON.stringify(message);
    });
    result += '\n';
    //result += '\n' + logEntry.stack + '\n';
    return result;
  };

  log.severities = ['error', 'warn', 'info', 'debug'];

  log.register = function(severity, source, base_) {
    if (base_)
      base_[severity] = createEntry.bind(null, severity, source);
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

  /**
   * Register a logging source. Call log.<source name>.<severity>(...) to
   * log something from that source.
   * @param {string} source
   */
  log.registerSource = function(source) {
    log.severities.forEach(function(severity) {
      log.register(severity, source);
    });
  };

  log.registerSource('');
})();
