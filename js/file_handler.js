/**
 * @fileoverview A file handler for pointer files (eg. .gdoc files) for
 * online documents. It simply parse them as JSON and open the URL specified
 * in the file.
 */
function FileHandler(items) {
  this.items_ = items || [];
  return this;
}

FileHandler.prototype.handle = function() {
  this.items_.forEach(function(item) {
    readFileEntry(item.entry, {maxSize: 1024}, function(json, err) {
      if (json) {
        var doc = JSON.parse(json);
        // TODO
      }
    });
  });
};
