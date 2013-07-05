/**
 * Invoke operationCallback(item, itemResultCallback) on every item in series.
 * All the arguments passed to each itemResultCallback call are preserved and
 * finally returned by calling resultCallback.
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

  if (items[0])
    operationCallback(items[0], function() {
      results_.push(arguments);
      asyncForEach(items.slice(1), operationCallback, resultCallback, results_);
    });
  else
    resultCallback(results_);
}

/**
 * Simplified version of asyncForEach, where operationCallback's callback
 * accepts only one argument. When resultCallback is called, it is passed with
 * an array of that argument in each callback.
 */
function asyncForEachSingleArgument(items, operationsCallback, resultCallback) {
  asyncForEach(items, operationsCallback, function(results) {
    resultCallback(results.map(function(args) {
      return args[0];
    }));
  });
}
