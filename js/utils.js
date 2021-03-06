/**
 * Invoke operationCallback(item, itemResultCallback) on every item in series.
 * All the arguments passed to each |itemResultCallback| call are preserved and
 * finally returned by calling |resultCallback|.
 * Sample:
 * asyncForEach(items, function(item, operationCompletedCallback) {
 *   doSomethingAsync(item, function(result1, result2) {
 *     // Invoke |operationCompletedCallback| to notify that the operation on
 *     // this item is completed.
 *     operationCompletedCallback(result1, result2);
 *   });
 * }, function(results) {
 *   // Everything is done here. Extract results now.
 *   var result1Array = results.map(function(args) {return args[0];});
 *   var result2Array = results.map(function(args) {return args[1];});
 *   // ...
 * });
 * @param {Array} items
 * @param {function} operationCallback Must specify a function that looks like:
 *     function(item, callback) {...}
 *     which performs an possibly asynchronous action on item and calls
 *     |callback| with the result of the action.
 * @param {function} resultCallback Must specify a function that looks like:
 *     function(argumentsInEachCallback) {...}
 *     where |argumentsInEachCallback| is an array of |arguments| passed to
 *     each |operationCallback|'s |callback|.
 * @param {Array} results_ Used internally to store the results. Do not pass
 *     this parameter when you call this function.
 */
function asyncForEach(items, operationCallback, resultCallback, results_) {
  if (!results_)
    results_ = [];

  if (items[0] !== undefined)
    operationCallback(items[0], function() {
      results_.push(arguments);
      asyncForEach(Array.prototype.slice.call(items, 1),
          operationCallback, resultCallback, results_);
    });
  else
    resultCallback(results_);
}

/**
 * Invoke operationCallback(item, itemResultCallback) on every item in parallel.
 * All the arguments passed to each |itemResultCallback| call are preserved and
 * finally returned by calling |resultCallback| when operations on all the items
 * are completed.
 * Sample:
 * See |asyncForEach|. Note that operations are performed parallel as opposed to
 * |asyncForEach|.
 * @param {Array} items
 * @param {function} operationCallback
 * @param {function} resultCallback
 */
function asyncEveryWithIndex(items, operationCallback, resultCallback) {
  var results = [];
  if (items.length == 0) {
    resultCallback(results);
    return;
  }

  Array.prototype.forEach.call(items, function(item, i) {
    operationCallback(item, i, function(i) {
      results[i] = Array.prototype.slice.call(arguments, 1);

      for (var i = 0; i < items.length; ++i)
        if (!results[i])
          return; // Return from this callback (effectively a 'continue').

      // At this point, operations on all items are completed and results are
      // available.
      resultCallback(results);
    }.bind(this, i));
  });
}

function asyncEvery(items, operationCallback, resultCallback) {
  asyncEveryWithIndex(items, function(item, index, callback) {
    operationCallback(item, callback);
  }, resultCallback);
};

/**
 * Simplified version of asyncForEach, where operationCallback's callback
 * accepts only one argument. When resultCallback is called, it is passed with
 * an array of that argument in each callback.
 */
function asyncForEach1(items, operationsCallback, resultCallback) {
  asyncForEach(items, operationsCallback, function(results) {
    resultCallback(results.map(function(args) {
      return args[0];
    }));
  });
}

function asyncEvery1(items, operationsCallback, resultCallback) {
  asyncEvery(items, operationsCallback, function(results) {
    resultCallback(results.map(function(args) {
      return args[0];
    }));
  });
}

function asyncEveryWithIndex1(items, operationsCallback, resultCallback) {
  asyncEveryWithIndex(items, operationsCallback, function(results) {
    resultCallback(results.map(function(args) {
      return args[0];
    }));
  });
}

function asyncCallEvery(callbacks, resultCallback) {
  asyncEvery(callbacks, function(callback, completedCallback) {
    callback(completedCallback);
  }, resultCallback);
}

/**
 * Execute callback(key, value) on the given dictionary's each item.
 * @param {object} dict
 * @param {function} callback
 */
function dictForEach(dict, callback) {
  for (var key in dict)
    callback(key, dict[key]);
}

/**
 * Return a new dictionary with both keys and values mapped by the specified
 * callback.
 * @param {object} dict
 * @param {function} callback This function takes item keys and values as
 *     parameters, and returns [<new key>, <new value>].
 * @returns {object} The new dictionary.
 */
function dictMap(dict, callback) {
  var newDict = {};
  dictForEach(dict, function(key, value) {
    var result = callback(key, value);
    newDict[result[0]] = result[1];
  });
  return newDict;
}

/**
 * Return a new dictionary with values mapped by the specified callback.
 * @param {object} dict
 * @param {function} callback This function takes item keys and values as
 *     parameters, and returns mapped item values.
 * @returns {object} The new dictionary.
 */
function dictMapValue(dict, callback) {
  return dictMap(dict, function(key, value) {
    return [key, callback(key, value)];
  });
}

/**
 * Return a new dictionary with keys mapped by the specified callback.
 * @param {object} dict
 * @param {function} callback This function takes item keys and values as
 *     parameters, and returns mapped item values.
 * @returns {object} The new dictionary.
 */
function dictMapValue(dict, callback) {
  return dictMap(dict, function(key, value) {
    return [callback(key, value), value];
  });
}

/**
 * Get a single item from the chrome.storage API and pass the value in the
 * callback.
 * @param {StorageArea} storageArea Either 'local' or 'sync'.
 * @param {string|Object} key_or_dict
 * @param {function} callback
 */
function storageGetItem(storageArea, key_or_dict, callback) {
  chrome.storage[storageArea].get(key_or_dict, function(items) {
		if (typeof key_or_dict == 'object')
			key_or_dict = Object.keys(key_or_dict)[0];
    callback(items[key_or_dict]);
  });
}

/**
 * Set a single item from the chrome.storage API.
 * @param {StorageArea} storageArea Either 'local' or 'sync'.
 * @param {string} key
 * @param {any} value
 * @param {function} callback
 */
function storageSetItem(storageArea, key, value, callback) {
	var items = {};
	items[key] = value;
  chrome.storage[storageArea].set(items, callback);
}

function strStartsWith(str1, str2) {
  return str1.substr(0, str2.length) == str2;
}

function strStripStart(str1, str2) {
  if (strStartsWith(str1, str2))
    return str1.substr(str2.length);
  else
    return str1;
}

function strEndsWith(str1, str2) {
  return str1.substr(-str2.length) == str2;
}

function strTrim(str) {
  return str.replace(/^\s+|\s+$/g, '');
}

/**
 * Invoke |callback| after specified number of milliseconds, trying to keep
 * the event page alive. Useful when you need to retry a network request after
 * a short period of time.
 * @param {function} callback
 * @param {integer} delay Number of milliseconds to wait before invoking
 *     |callback|. If the delay is longer than a few seconds, please consider
 *     using chrome.alarms instead of keeping the event page alive.
 */
function setTimeoutKeepAlive(callback, delay) {
  // The default value is 10 seconds and can be overriden with a command line
  // flag. For more information, Search for event_page_idle_time_ in
  // chrome/browser/extensions/extension_process_manager.cc.
  var EVENT_PAGE_IDLE_TIME = 5000;

  // This magic extension API call makes sure the event page is not idle now
  // and the idle time will be counted from now on.
  chrome.storage.local.get('_', function() {
    if (delay > EVENT_PAGE_IDLE_TIME) {
      window.setTimeout(setTimeoutKeepAlive.bind(null, callback,
          delay - EVENT_PAGE_IDLE_TIME), EVENT_PAGE_IDLE_TIME);
    } else
      window.setTimeout(callback, delay);
  });
}

function boolEquals(a, b) {
  return (a && b) || (!a && !b);
}

function readBlob(blob, format, callback) {
  var reader = new FileReader();
  reader.onload = function() {
    callback(reader.result);
  };
  reader.onerror = function() {
    callback(null, reader.error);
  };
  switch (format) {
    case 'arraybuffer':
      reader.readAsArrayBuffer(blob);
      break;
    case 'binarystring':
      reader.readAsBinaryString(blob);
      break;
    case 'dataurl':
      reader.readAsDataURL(blob);
      break;
    default:
      reader.readAsText(blob);
      break;
  }
}

function readFileEntry(entry, options, callback) {
  if (!options)
    options = {};
  entry.file(function(file) {
    if (options.maxSize && file.size > options.maxSize)
      callback();
    else
      readBlob(file, options.format, callback);
  }, function(err) {
    callback(null, err);
  });
}

// For debugging.
var __;
function _() {
  if (arguments.length < 2)
    console.log(__ = arguments[0]);
  else
    console.log(__ = arguments);
}

function _R(source) {
  var reader = new FileReader();
  reader.onload = function() {
    console.log(reader.result);
  };
  function handleBlob(blob) {
    reader.readAsText(blob);
  }
  if (source.file)
    source.file(handleBlob);
  else
    handleBlob(source);
}

function _randomDelay(callback, unit) {
  window.setTimeout(callback, Math.random() * (unit || 1000));
};
