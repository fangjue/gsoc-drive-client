/**
 * @fileoverview A simple JavaScript set. Only string items are supported. Other
 * types will be converted to strings.
 */

'use strict';

/**
 * Create a new set, optionally initializing with items specified in arguments.
 * @constructor
 * @param {...string} item One or more items to add into the new set.
 */
var Set = function(var_args) {
  this.items_ = {};
  this.add.apply(this, arguments);
  return this;
};

/**
 * Add one or more items into the set.
 * @param {...string} item Item(s) to add.
 */
Set.prototype.add = function(var_args) {
  Array.prototype.forEach.call(arguments, function(item) {
    this.items_[item] = true;
  }.bind(this));
};

/**
 * Remove one or more items into the set.
 * @param {...string} item Item(s) to remove.
 */
Set.prototype.remove = function(var_args) {
  Array.prototype.forEach.call(arguments, function(item) {
    delete this.items_[item];
  }.bind(this));
};

/**
 * Remove all items in the set.
 */
Set.prototype.clear = function() {
  this.items_ = {};
};

/**
 * Returns true if the specified item is in the set.
 * @param {string} item The item to check existence for.
 */
Set.prototype.contains = function(item) {
  return this.items_.hasOwnProperty(item);
};

/**
 * Convert the set to an array with all items.
 * @returns {Array.string}
 */
Set.prototype.toArray = function() {
  return Object.keys(this.items_);
};

/**
 * Create a new set from an array.
 * @param {Array.string} items The items to be added into the new set.
 * @returns {Set}
 */
Set.fromArray = function(items) {
  var set = new Set();
  Set.prototype.add.apply(set, items);
  return set;
};

/**
 * Get the number of items in the set.
 * @returns {integer}
 */
Set.prototype.getLength = function() {
  return this.toArray().length;
};

/**
 * Create a new instance of the set with the same items.
 * @returns {Set}
 */
Set.prototype.clone = function() {
  return Set.fromArray(Object.keys(this.items_));
};

/**
 * Returns the union of this set and another one.
 * @param {Set} that
 * @returns {Set}
 */
Set.prototype.union = function(that) {
  var result = this.clone();
  result.add.apply(result, that.toArray());
  return result;
};

/**
 * Returns the intersection of this set and another one.
 * @param {Set} that
 * @returns {Set}
 */
Set.prototype.intersect = function(that) {
  var result = this.clone();

  this.toArray().forEach(function(item) {
    if (!that.contains(item))
      result.remove(item);
  });

  return result;
};

/**
 * Returns the result of this set minus another one.
 * @param {Set} that
 * @returns {Set}
 */
Set.prototype.minus = function(that) {
  var result = this.clone();
  Set.prototype.remove.apply(result, that.toArray());
  return result;
};

/**
 * Shorthand of set.toArray().forEach(...).
 * @param {function} callback See also Array.prototype.forEach.
 */
Set.prototype.forEach = function() {
  Array.prototype.forEach.apply(this.toArray(), arguments);
};

Set.prototype.filter = function() {
  return Set.fromArray(Array.prototype.filter.apply(this.toArray(),
      arguments));
};
