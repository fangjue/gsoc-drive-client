/**
 * @fileoverview A Google Drive JavaScript library that works in the Chrome
 * Apps platform.
 */

'use strict';

var GoogleDrive = function(opt_options) {
  if (!opt_options)
    opt_options = {};

  this.DRIVE_API_FILES_BASE_URL = 'https://www.googleapis.com/drive/v2/files';
  this.DRIVE_API_FILES_UPLOAD_URL =
      'https://www.googleapis.com/upload/drive/v2/files';
  this.DRIVE_API_CHANGES_BASE_URL =
      'https://www.googleapis.com/drive/v2/changes';
  this.DRIVE_API_ABOUT_URL = 'https://www.googleapis.com/drive/v2/about';
  this.DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
  this.DRIVE_API_MAX_RESULTS = 1000;

  this.getToken_ = opt_options.tokenProvider || function(callback) {
    (chrome.identity || chrome.experimental.identity).getAuthToken(
        {}, callback);
  };

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

/*
 * @typedef {object} XHRDetails
 * @property {string} responseType XHR response type, such as 'blob'.
 * @property {object} queryParameters A dictionary containing query parameters.
 *     Keys are parameter names and values are parameter values.
 * @property {string} contentType HTTP Content-Type header.
 * @property {MultipartBodyDetails} multipartBody Multipart request body
 *     content.
 */

/**
 * Send a XHR request.
 * @param {string} method 'GET', 'POST' or other HTTP methods.
 * @param {string} url Request URL.
 * @param {XHRDetails} opt_details Request details, including request body,
 *     content type, etc.
 * @param {function} opt_callback Called with the response.
 */
GoogleDrive.prototype.sendRequest = function(method, url, opt_details,
    opt_callback) {
  if (!opt_details)
    opt_details = {};
  console.assert(!(opt_details.body && opt_details.multipartBody));
  console.assert(!(opt_details.contentType && opt_details.multipartBody));

  this.getToken_(function(token) {
    if (!token) {
      if (opt_callback)
        opt_callback(null, {tokenError: true});
      return;
    }

    if (opt_details.queryParameters)
      url += this.generateQuery_(opt_details.queryParameters);

    var xhr = new XMLHttpRequest();
    // TODO: onprogress, upload.onprogress

    xhr.open(method, url, true);
    if (opt_details.responseType)
      xhr.responseType = opt_details.responseType;
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    if (opt_details.contentType)
      xhr.setRequestHeader('Content-Type', opt_details.contentType);
    if (opt_details.range) {
      var start = '';
      var end = '';
      if (opt_details.range.start != null)
        start = opt_details.range.start.toString();
      if (opt_details.range.end != null)
        end = opt_details.range.end.toString();
      xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
    }

    var requestBody = opt_details.body;
    if (opt_details.multipartBody) {
      xhr.setRequestHeader('Content-Type', 'multipart/mixed; boundary="' +
          opt_details.multipartBody.boundary + '"');
      requestBody = this.generateMultipartRequestBody_(
          opt_details.multipartBody);
    }

    xhr.onreadystatechange = function() {
      if (xhr.readyState == XMLHttpRequest.DONE && opt_callback) {
        opt_callback(xhr);
        xhr = null;
      }
    };

    xhr.send(requestBody);
  }.bind(this));
};

GoogleDrive.prototype.generateQuery_ = function(params) {
  return '?' + Object.keys(params).map(function(key) {
    return escape(key) + '=' + escape(params[key]);
  }).join('&');
};

/**
 * Generate the multipart request body.
 * @param {MultipartBodyDetails} details Multipart body details.
 * @return {string} Returns the request body string that can be sent directly.
 */
GoogleDrive.prototype.generateMultipartRequestBody_ = function(details) {
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

/**
 * Send an API request to Google Drive that responds with a Files resource.
 * @param {string} method HTTP method.
 * @param {object} details
 * @param {function} callback Called with the returned GoogleDriveEntry.
 */
GoogleDrive.prototype.sendFilesRequest = function(method, details, callback) {
  var url = this.DRIVE_API_FILES_BASE_URL;
  var xhr_details = {};

  if (details.upload)
    url = this.DRIVE_API_FILES_UPLOAD_URL;
  if (details.fileId)
    url += '/' + details.fileId;

  if (details.uploadType)
    xhr_details.queryParameters = {uploadType: details.uploadType};
  if (details.multipartBody)
    xhr_details.multipartBody = details.multipartBody;
  if (details.body)
    xhr_details.body = details.body;
  if (!details.upload)
    xhr_details.contentType = 'application/json';

  this.sendRequest(method, url, xhr_details, function(xhr, error) {
    if (error)
      callback(null, error);
    else if (xhr.status == 200)
      callback(new GoogleDriveEntry(JSON.parse(xhr.responseText), this));
    else
      callback(null, {status: xhr.status});
  }.bind(this));
};

/**
 * @param {string} method The method to use: POST to upload a new file, PUT
 *     to update an existing file, PATCH to update metadata of an existing
 *     file.
 * @param {object} options Upload request options.
 * @param {object} opt_metadata A Files resource object that represents the
 *     metadata of the file. No metadata will be sent if omitted.
 * @param {Blob} opt_content The content of the file, represented as a Blob.
 *     No content will be sent if omitted.
 * @param {function} callback Called with the GoogleDriveEntry object.
 */
GoogleDrive.prototype.sendUploadRequest = function(method, options,
    opt_metadata, opt_content, callback) {
  console.assert(opt_metadata || opt_content);

  // TODO: Send resumable upload request when the file size is larger than
  // a certain threshold.
  if (opt_metadata && opt_content)
    this.sendMultipartUploadRequest(method, options, opt_metadata,
        opt_content, callback);
  else if (opt_metadata) {
    var filesRequestOptions = {
      body: JSON.stringify(opt_metadata)
    };
    if (options.fileId)
      filesRequestOptions.fileId = options.fileId;
    this.sendFilesRequest(method, filesRequestOptions, callback);
  } else
    this.readBlob_(opt_content, 'base64', function(base64Data) {
      var filesRequestOptions = {
        upload: true,
        uploadType: 'media',
        body: base64Data
      };
      if (options.upload)
        fileRequestOptions.upload = options.upload;
      if (options.fileId)
        filesRequestOptions.fileId = options.fileId;
      this.sendFilesRequest(method, filesRequestOptions, callback);
    }.bind(this));
};

/**
 * Read the content of a blob.
 * @param {Blob} The Blob object to read.
 * @param {string} format 'base64', 'arraybuffer', etc.
 * @param {callback} Called when the operation is completed.
 */
GoogleDrive.prototype.readBlob_ = function(blob, format, callback) {
  var fileReader = new FileReader();
  fileReader.onload = function() {
    if (format == 'base64')
      callback(btoa(fileReader.result));
    else
      callback(fileReader.result);
  };
  if (format == 'base64')
    fileReader.readAsBinaryString(blob);
  else
    fileReader.readAsArrayBuffer(blob);
};

GoogleDrive.prototype.sendMultipartUploadRequest = function(method, options,
    metadata, content, callback) {
  this.readBlob_(content, 'base64', function(base64Data) {
    var filesRequestOptions = {
      upload: true,
      uploadType: 'multipart',
      multipartBody: {
        boundary: '--------GoogleDriveClientUploadBoundary',
        parts: [
          {
            contentType: 'application/json',
            content: JSON.stringify(metadata)
          },
          {
            contentType: metadata.type || 'application/octet-stream',
            encoding: 'base64',
            content: base64Data
          }
        ]
      }
    };

    if (options.fileId)
      filesRequestOptions.fileId = options.fileId;
    this.sendFilesRequest(method, filesRequestOptions, callback);
  }.bind(this));
}

// TODO
// TODO: Add a callback to fetch file data to upload on demand.
GoogleDrive.prototype.sendResumableUploadRequest = function(method, options,
    metadata, content, callback) {
}

// TODO: Some multi page requests (changes.list) may have important values in
// the response (largestChangeId).
GoogleDrive.prototype.sendMultiPageRequest = function(method, url, options,
    callback, multiPageOptions) {
  var maxResults;
  if (options.maxResults)
    maxResults = Math.min(options.maxResults, this.DRIVE_API_MAX_RESULTS);
  else
    maxResults = this.DRIVE_API_MAX_RESULTS;

  // TODO: options -> xhr_options.
  var xhr_options = {
    queryParameters: {
      maxResults: maxResults,
    }
  };

  if (options.queryParameters)
    for (var key in options.queryParameters)
      xhr_options.queryParameters[key] = options.queryParameters[key];

  if (options.q)
    xhr_options.queryParameters['q'] = options.q;

  if (!multiPageOptions)
    multiPageOptions = {itemsSoFar: []};
  if (multiPageOptions.nextPageToken)
    xhr_options.queryParameters['pageToken'] = multiPageOptions.nextPageToken;

  this.sendRequest(method, url, xhr_options, function(xhr, error) {
    if (error)
      callback(multiPageOptions.itemsSoFar, error);
    else if (xhr.status != 200)
      callback(multiPageOptions.itemsSoFar, {status: xhr.status});
    else {
      var response = JSON.parse(xhr.responseText);
      var items = response.items;
      multiPageOptions.itemsSoFar =
          multiPageOptions.itemsSoFar.concat(items);
      if (options.maxResults)
        callback(multiPageOptions.itemsSoFar);
      else if (response.nextPageToken) {
        multiPageOptions.nextPageToken = response.nextPageToken;
        this.sendMultiPageRequest(method, url, options, callback,
            multiPageOptions);
      } else
        callback(multiPageOptions.itemsSoFar);
    }
  }.bind(this));
};

/**
 * Upload a file to Google Drive.
 * @param {object} metadata File metadata such as description, title, etc.
 * @param {Blob} content File content as a Blob.
 * @param {function} callback Called to report progress and status.
 */
GoogleDrive.prototype.upload = function(metadata, content, callback) {
  this.sendUploadRequest('POST', {}, metadata, content, callback)
};

/**
 * Get a file's metadata by ID.
 * @param {string} fileId The file's ID.
 * @param {function} callback Called with a GoogleDriveEntry object.
 */
GoogleDrive.prototype.get = function(fileId, callback) {
  this.sendFilesRequest('GET', {fileId: fileId}, callback);
};

GoogleDrive.prototype.update = function(fileId, opt_fullMetadata,
    opt_metadataUpdates, opt_content, callback) {
  console.assert(!(opt_fullMetadata && opt_metadataUpdates));
  if (opt_metadataUpdates)
    this.sendUploadRequest('PATCH', {fileId: fileId},
        opt_metadata, null, callback);
  else if (opt_content || opt_fullMetadata)
    this.sendUploadRequest('PUT', {fileId: fileId},
        opt_fullMetadata, opt_content, callback);
};

GoogleDrive.prototype.createFolder = function(parentId, title, callback) {
  this.sendFilesRequest('POST', {body: JSON.stringify({
      title: title,
      parents: [{id: parentId}],
      mimeType: this.DRIVE_FOLDER_MIME_TYPE
  })}, callback);
};

/**
 * Get all children under a folder specified by |parentId|.
 * @param {string} parentId
 * @param {object} opt_options
 * @param {function} callback Called with child ids or GoogleDriveEntry objects.
 */
GoogleDrive.prototype.getChildren = function(parentId, opt_options, callback) {
  // TODO: opt_options. (populate)
  // TODO: nextPageToken.
  this.getAll({q: '\'' + parentId + '\' in parents'}, callback);
};

/**
 * @param {object} opt_options
 * @param {function} callback Called with GoogleDriveEntry objects.
 */
GoogleDrive.prototype.getAll = function(opt_options, callback) {
  this.sendMultiPageRequest('GET', this.DRIVE_API_FILES_BASE_URL, opt_options || {}, function(items, error) {
    callback(items.map(function(item) {
      return new GoogleDriveEntry(item, this);
    }.bind(this)), error);
  }.bind(this));
};

/**
 * Get basic information of this Drive account, including user information,
 * quota usage, latest change id, etc.
 * @param {function} callback Called with an About Resource.
 */
GoogleDrive.prototype.getInfo = function(callback) {
  this.sendRequest('GET', this.DRIVE_API_ABOUT_URL, {}, function(xhr, error) {
    if (error)
      callback(null, error);
    else if (xhr.status != 200)
      callback(null, {status: xhr.status});
    else
      callback(JSON.parse(xhr.responseText));
  }.bind(this));
};

/**
 * Get the value of a custom file property.
 * @param {string} fileId The file's id.
 * @param {string} propertyKey Property key.
 * @param {boolean} isPublic Whether this property is visible to all apps or
 *     only accessible to the app that creates it.
 * @param {function} callback Called with the property value.
 */
GoogleDrive.prototype.getProperty = function(fileId, propertyKey, isPublic,
    callback) {
  var url = this.DRIVE_API_FILES_BASE_URL + '/' + fileId +
      '/properties/' + propertyKey;
  this.sendRequest('GET', url, {queryParameters: {visibility:
      isPublic ? 'PUBLIC' : 'PRIVATE'}}, function(xhr, error) {
    if (error)
      callback(null, error);
    else if (xhr.status != 200)
      callback(null, {status: xhr.status});
    else
      callback(JSON.parse(xhr.responseText).value);
  }.bind(this));
};

/**
 * Get the value of a custom file property.
 * @param {string} fileId The file's id.
 * @param {string} propertyKey Property key.
 * @param {boolean} isPublic Whether this property is visible to all apps or
 *     only accessible to the app that creates it.
 * @param {function} callback Called with the property value.
 */
GoogleDrive.prototype.setProperty = function(fileId, propertyKey, isPublic,
    value, callback) {
  var url = this.DRIVE_API_FILES_BASE_URL + '/' + fileId + '/properties';
  // properties.insert request works as expected even if the property
  // already exists.
  this.sendRequest('POST', url, {body: JSON.stringify({
      key: propertyKey,
      value: value,
      visibility: isPublic ? 'PUBLIC' : 'PRIVATE'
  }), contentType: 'application/json'}, function(xhr, error) {
    if (error)
      callback(null, error);
    else if (xhr.status != 200)
      callback(null, {status: xhr.status});
    else
      callback(JSON.parse(xhr.responseText));
  }.bind(this));
};

GoogleDrive.prototype.getChanges = function(options, callback) {
  this.sendMultiPageRequest('GET', this.DRIVE_API_CHANGES_BASE_URL,
      {queryParameters: {startChangeId: options.startChangeId}}, callback);
};

var GoogleDriveEntry = function(details, drive) {
  this.details = details;
  this.drive_ = drive;
  return this;
};

GoogleDriveEntry.prototype.update = function(opt_metadata, opt_content,
    callback) {
  this.drive_.update(this.details.id, null, opt_metadata, opt_content, callback);
};

// TODO: Add options.range, etc.
GoogleDriveEntry.prototype.download = function(options, callback) {
  if (!this.details.downloadUrl) {
    callback();
    return;
  }

  if (!opt_options)
    opt_options = {};

  this.drive_.sendRequest('GET', this.details.downloadUrl,
      {responseType: 'blob'}, function(xhr, error) {
        if (error)
          callback(null, error);
        if (xhr.status == 200 || xhr.status == 206)
          callback(xhr.response);
        else
          callback(null, {status: xhr.status});
      }.bind(this));
};

GoogleDriveEntry.prototype.isFolder = function() {
  return this.details.mimeType == this.drive_.DRIVE_FOLDER_MIME_TYPE;
};

GoogleDriveEntry.prototype.getChildren = function(callback) {
  console.assert(this.isFolder());
  this.drive_.getChildren(this.details.id, {populate: true}, callback);
};

// For debugging.
var __;
function _() {
  if (arguments.length < 2 )
    console.log(__ = arguments[0]);
  else
    console.log(__ = arguments);
var d = new GoogleDrive();}
