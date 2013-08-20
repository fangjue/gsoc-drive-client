/**
 * @fileoverview RequestSender is a convenient wrapper for XMLHttpRequest that
 * supports various request and response types used in this app.
 */

'use strict';

log.registerSource('RequestSender');

var RequestSender = function() {
  this.pendingRequests_ = [];

  return this;
};

/**
 * @typedef {object} MultipartBodyPart
 * @property {string} content The content of this part as a string.
 * @property {string} contentType MIME type for this part.
 * @property {string} encoding Value of 'Content-Transfer-Encoding'.
 */

/**
 * @typedef {object} MultipartBodyDetails
 * @property {string} boundary The boundary string to use.
 * @property {Array.MultipartBodyPart} parts An array of all parts.
 */

/**
 * @typedef {object} HTTPRange
 * @property {long|string} start Start offset of the range. Can be '*' if
 *     unknown.
 * @property {long|string} end End offset of the range, including this byte. Can
 *     be '*' if unknown.
 * @property {long|string} total Total number of bytes. Can be '*' if unknown.
 */

/*
 * @typedef {object} XHRDetails
 * @property {object} queryParameters A dictionary containing query parameters.
 *     Keys are parameter names and values are parameter values. You mustn't
 *     supply query parameters if the request URL already contains a query
 *     string.
 * @property {string} authorization HTTP Authorization header.
 * @property {HTTPRange} contentRange HTTP Content-Range header.
 * @property {string} contentType HTTP Content-Type header.
 * @property {string} ifMatch If-Match HTTP header.
 * @property {HTTPRange} range HTTP Range header. Only |start| and |end|
 *     properties can be used here.
 * @property {object} headers A dictionary containing additional HTTP headers.
 *     Keys are HTTP header names and values are HTTP header values.
 * @property {string|Blob|File|object} body Request body that will be passed
 *     to XMLHttpRequest's send method. If it's an Object, it will be
 *     JSON-stringified, and the content type will be automatically set to
 *     'application/json'. Other types (string|Blob|File) of body will be used
 *     as is.
 * @property {MultipartBodyDetails} multipartBody Multipart request body
 *     content.
 * @property {Array.integer} expectedStatus Expected status codes returned
 *     from the server to indicate success. |callback| is called with xhrError
 *     property in the error parameter if the actual status code doesn't match
 *     any of these codes specified.
 * @property {string} responseType XHR response type, such as 'blob'.
 */

/**
 * Send a generic XHR request.
 * @param {string} method Standard HTTP method.
 * @param {string} url Request URL.
 * @param {XHRDetails} details Request details, including request body,
 *     content type, etc.
 * @param {function} callback Called with the response.
 */
RequestSender.prototype.sendRequest = function(method, url, details, callback) {
  if (!details)
    details = {};

  console.assert(!(details.body && details.multipartBody));
  console.assert(!(details.contentType && details.multipartBody));
  console.assert(!(url.indexOf('?') != -1 &&
                   Object.keys(details.queryParameters || {})).length > 0);
  if (details.body) {
    console.assert([String, Object, Blob, File].indexOf(
        details.body.constructor) != -1);
    console.assert(!(details.contentType &&
                     details.body.constructor == Object));
  }

  if (details.queryParameters && url.indexOf('?') == -1)
    url += this.generateQuery_(details.queryParameters);

  var xhr = new XMLHttpRequest();
  var pendingRequest = {xhr: xhr, method: method, url: url};
  // TODO: onprogress, upload.onprogress

  xhr.open(method, url, true);
  if (details.responseType)
    xhr.responseType = details.responseType;
  if (details.authorization)
    xhr.setRequestHeader('Authorization', details.authorization);
  if (details.ifMatch)
    xhr.setRequestHeader('If-Match', details.ifMatch);

  if (details.range)
    xhr.setRequestHeader('Range', this.getRangeHeader_(details.range));

  if (details.contentRange) {
    xhr.setRequestHeader('Content-Range',
        this.getContentRangeHeader_(details.contentRange));
  }

  var requestBody = details.body;
  if (requestBody && requestBody.constructor == Object) {
    requestBody = JSON.stringify(requestBody);
    xhr.setRequestHeader('Content-Type', 'application/json');
  } else if (details.multipartBody) {
    xhr.setRequestHeader('Content-Type', 'multipart/mixed; boundary="' +
        details.multipartBody.boundary + '"');
    requestBody = this.generateMultipartRequestBody_(
        details.multipartBody);
  } else if (details.contentType)
    xhr.setRequestHeader('Content-Type', details.contentType);

  if (details.headers) {
    Object.keys(details.headers).forEach(function(name) {
      xhr.setRequestHeader(name, details.headers[name]);
    });
  }

  xhr.onreadystatechange = function() {
    if (xhr.readyState == XMLHttpRequest.DONE) {
      pendingRequest.endTime = new Date();
      this.logRequest_(pendingRequest);
      var index = this.pendingRequests_.indexOf(pendingRequest);
      if (index != -1)
        this.pendingRequests_.splice(index, 1);

      var error = false;
      if (details.expectedStatus) {
        if (details.expectedStatus.indexOf(xhr.status) == -1)
          error = true;
      } else if (xhr.status < 200 || xhr.status >= 300)
        error = true;

      if (error)
        callback(xhr, {xhrError: {
            status: xhr.status,
            response: xhr.response}});
      else
        callback(xhr);
      xhr = null;
    }
  }.bind(this);

  pendingRequest.startTime = new Date();
  xhr.send(requestBody);
  this.pendingRequests_.push(pendingRequest);
};

RequestSender.prototype.logRequest_ = function(pendingRequest) {
  log.RequestSender.debug(pendingRequest.method,
                          pendingRequest.url,
                          pendingRequest.endTime - pendingRequest.startTime);
};

RequestSender.prototype.getRangeHeader_ = function(range) {
  console.assert(!(range.start == null && range.end == null));
  var start = '';
  var end = '';
  if (range.start != null)
    start = range.start.toString();
  if (range.end != null)
    end = range.end.toString();
  return 'bytes=' + start + '-' + end;
};

RequestSender.prototype.getContentRangeHeader_ = function(contentRange) {
  var range = '*';
  if (contentRange.start != null && contentRange.end != null)
    range = contentRange.start.toString() + '-' + contentRange.end.toString();
  return 'bytes ' + range + '/' + (contentRange.total || '*');
};

RequestSender.prototype.generateQuery_ = function(params) {
  if (Object.keys(params).length == 0)
    return '';
  return '?' + Object.keys(params).map(function(key) {
    return escape(key) + '=' + escape(params[key]);
  }).join('&');
};

/**
 * Generate the multipart request body.
 * @param {MultipartBodyDetails} details Multipart body details.
 * @return {string} Returns the request body string that can be sent directly.
 */
RequestSender.prototype.generateMultipartRequestBody_ = function(details) {
  var crlf = '\r\n';
  var delimiter = crlf + '--' + details.boundary + crlf;
  var ending = crlf + '--' + details.boundary + '--';
  var body = '';
  return details.parts.map(function(part) {
    var bodyPart = delimiter;
    if (part.contentType)
      bodyPart += 'Content-Type: ' + part.contentType + crlf;
    if (part.encoding)
      bodyPart += 'Content-Transfer-Encoding: ' + part.encoding + crlf;
    return bodyPart + crlf + part.content;
  }).join('') + ending;
};
