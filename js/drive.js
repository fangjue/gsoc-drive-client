/**
 * @fileoverview A Google Drive JavaScript library that works in the Chrome
 * Apps platform.
 */

'use strict';

var GoogleDrive = function(opt_options) {
  if (!opt_options)
    opt_options = {};

  this.DEFAULT_MIME_TYPE = 'application/octet-stream';
  // Chunk sizes must be a multiple of 256 KB.
  this.DEFAULT_UPLOAD_CHUNK_SIZE = 256 * 1024 * 4;
  this.DRIVE_API_FILES_BASE_URL = 'https://www.googleapis.com/drive/v2/files';
  this.DRIVE_API_FILES_UPLOAD_URL =
      'https://www.googleapis.com/upload/drive/v2/files';
  this.DRIVE_API_CHANGES_BASE_URL =
      'https://www.googleapis.com/drive/v2/changes';
  this.DRIVE_API_ABOUT_URL = 'https://www.googleapis.com/drive/v2/about';
  this.DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
  // TODO: Figure out the best value for list requests.
  this.DRIVE_API_MAX_RESULTS = 1000;

  this.getToken_ = opt_options.tokenProvider || function(callback) {
    (chrome.identity || chrome.experimental.identity).getAuthToken(
        {}, callback);
  };

  if (!opt_options.prettyPrint)
    this.prettyPrint_ = 'false';
  this.fields_ = opt_options.fields || {};

  this.pendingResumableUploads_ = {};

  return this;
};

/**
 * @typedef {object} DriveAPIError
 * @property {object} tokenError
 * @property {object} xhrError
 */

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
 * @property {Array.integer} expectedStatus Expected status codes returned
 *     from the server to indicate success. |callback| is called with xhrError
 *     property in the error parameter if the actual status code doesn't match
 *     any of these codes specified.
 */

/**
 * Send a generic XHR request.
 * @param {string} method 'GET', 'POST' or other HTTP methods.
 * @param {string} url Request URL.
 * @param {XHRDetails} opt_details Request details, including request body,
 *     content type, etc.
 * @param {function} callback Called with the response.
 */
GoogleDrive.prototype.sendRequest = function(method, url, opt_details,
    callback) {
  if (!opt_details)
    opt_details = {};
  console.assert(!(opt_details.body && opt_details.multipartBody));
  console.assert(!(opt_details.contentType && opt_details.multipartBody));

  this.getToken_(function(token) {
    if (!token) {
      callback(null, {tokenError: {details: chrome.runtime.lastError}});
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

    if (opt_details.contentRange) {
      var range = '*';
      if (opt_details.contentRange.start != null &&
          opt_details.contentRange.end != null)
        range = opt_details.contentRange.start.toString() + '-' +
            opt_details.contentRange.end.toString();
      xhr.setRequestHeader('Content-Range', 'bytes ' + range + '/' +
          (opt_details.contentRange.total || '*'));
    }

    var requestBody = opt_details.body;
    if (opt_details.multipartBody) {
      xhr.setRequestHeader('Content-Type', 'multipart/mixed; boundary="' +
          opt_details.multipartBody.boundary + '"');
      requestBody = this.generateMultipartRequestBody_(
          opt_details.multipartBody);
    }

    if (opt_details.headers)
      Object.keys(opt_details.headers).forEach(function(name) {
        xhr.setRequestHeader(name, opt_details.headers[name]);
      });

    xhr.onreadystatechange = function() {
      if (xhr.readyState == XMLHttpRequest.DONE) {
        if ((opt_details.expectedStatus || [200]).indexOf(xhr.status) == -1)
          callback(xhr, {xhrError: {
              status: xhr.status,
              response: xhr.response}});
        else
          callback(xhr);
        xhr = null;
      }
    };

    xhr.send(requestBody);
  }.bind(this));
};

GoogleDrive.prototype.generateQuery_ = function(params) {
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

GoogleDrive.prototype.sendDriveRequest_ = function(method, url, options, callback) {
  if (this.prettyPrint_)
    if (!options.queryParameters)
      options.queryParameters = {};
    if (!options.queryParameters.prettyPrint)
      options.queryParameters.prettyPrint = this.prettyPrint_;
  this.sendRequest(method, url, options, callback);
};

/**
 * Send an API request to Google Drive that responds with a Files resource.
 * @param {string} method HTTP method.
 * @param {object} details
 * @param {function} callback Called with the returned GoogleDriveEntry.
 */
GoogleDrive.prototype.sendFilesRequest = function(method, details, callback) {
  var url = this.DRIVE_API_FILES_BASE_URL;
  var xhr_details = {
    expectedStatus: [200],
    queryParameters: {},
  };

  if (details.upload)
    url = this.DRIVE_API_FILES_UPLOAD_URL;
  if (details.fileId)
    url += '/' + details.fileId;

  if (details.uploadType)
    xhr_details.queryParameters.uploadType = details.uploadType;
  if (details.fields)
    xhr_details.queryParameters.fields = details.fields;
  else if (this.fields_.files)
    xhr_details.queryParameters.fields = this.fields_.files;
  if (details.multipartBody)
    xhr_details.multipartBody = details.multipartBody;
  if (details.body)
    xhr_details.body = details.body;
  if (!details.upload)
    xhr_details.contentType = 'application/json';

  this.sendDriveRequest_(method, url, xhr_details, function(xhr, error) {
    if (error)
      callback(null, error);
    else
      callback(new GoogleDriveEntry(JSON.parse(xhr.responseText), this));
  }.bind(this));
};

/**
 * @param {string} method The method to use: POST to upload a new file, PUT
 *     to update an existing file, PATCH to update metadata of an existing
 *     file.
 * @param {object} options Upload request options.
 * @param {object} opt_metadata A Files resource object that represents the
 *     metadata of the file. No metadata will be sent if omitted.
 * @param {Blob|File} opt_content The content of the file, represented as a
 *     Blob. No content will be sent if omitted.
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
 * @param {Blob|File} The Blob object to read.
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
GoogleDrive.prototype.sendResumableUploadRequest = function(method, options,
    opt_metadata, content, callback) {
  console.assert(content.size != 0);
  var xhr_options = {
    queryParameters: {
      uploadType: 'resumable'
    },
    headers: {
      'X-Upload-Content-Type': content.type || this.DEFAULT_MIME_TYPE,
      'X-Upload-Content-Length': content.size
    },
    expectedStatus: [200],
  };

  if (opt_metadata) {
    xhr_options.contentType = 'application/json';
    xhr_options.body = JSON.stringify(opt_metadata);
  }
  // TODO: URL
  this.sendDriveRequest_(method, this.DRIVE_API_FILES_UPLOAD_URL, xhr_options,
      function(xhr, error) {
    if (error)
      callback(null, error);
    else
      this.startResumableUploadSession_(xhr.getResponseHeader('Location'),
          options, content, callback);
  }.bind(this));
};

GoogleDrive.prototype.startResumableUploadSession_ = function(sessionUrl,
    options, content, callback) {
  var chunkSize = options.chunkSize || this.DEFAULT_UPLOAD_CHUNK_SIZE;
  // TODO: Persistent storage for interrupted uploads.
  this.pendingResumableUploads_[sessionUrl] = {
    sessionUrl: sessionUrl,
    chunkSize: chunkSize,
    content: content, 
    callback: callback,
    currentOffset: 0,
    uploadedSize: 0
  };
  this.uploadNextChunk_(sessionUrl);
};

GoogleDrive.prototype.uploadNextChunk_ = function(sessionUrl) {
  var info = this.pendingResumableUploads_[sessionUrl];
  if (!info)
    return;
  var slicedContent = info.content.slice(info.currentOffset,
      info.currentOffset + info.chunkSize);
  this.sendDriveRequest_('PUT', sessionUrl, {
    contentRange: {
      start: info.currentOffset,
      end: info.currentOffset + slicedContent.size - 1,
      total: info.content.size
    },
    body: slicedContent,
    contentType: slicedContent.type || this.DEFAULT_MIME_TYPE,
    expectedStatus: [200, 201, 308],
  }, function(xhr, error) {
    if (error) {
      var callback = info.callback;
      if (xhr.status == 404) {
        // Upload cannot be resumed any more.
        delete this.pendingResumableUploads_[sessionUrl];
      } else {
        error.resumeId = sessionUrl;
        info.interrupted = true;
      }
      callback(null, error);
    } else if (xhr.status == '200' || xhr.status == '201') {
      // Upload is completed.
      info.callback(new GoogleDriveEntry(JSON.parse(xhr.responseText),
          this));
    } else if (xhr.status == 308)
      this.processResumableUploadResponse_(sessionUrl, xhr, info);
  }.bind(this));
};

GoogleDrive.prototype.processResumableUploadResponse_ = function(sessionUrl,
    xhr, info) {
  // The current chunk is uploaded.
  var uploadedRange = xhr.getResponseHeader('Range');
  if (uploadedRange) {
    var uploadedEnd = uploadedRange.substr(uploadedRange.indexOf('-') + 1);
    // Google Drive accepts files with a maximum size of 10 GB, which is
    // still in the range that parseInt can handle.
    info.currentOffset = parseInt(uploadedEnd) + 1;
  } else
    info.currentOffset = 0;
  info.uploadedSize = info.currentOffset;

  this.uploadNextChunk_(sessionUrl);
};

GoogleDrive.prototype.resumeUpload = function(resumeId, content, callback) {
  var info = this.pendingResumableUploads_[resumeId];
  if (!info) {
    callback(null, {});
    return;
  }
  info.content = content;

  this.sendDriveRequest_('PUT', info.sessionUrl,
      {contentRange: {total: content.size}, expectedStatus: [200, 308]}, function(xhr, error) {
    if (error) {
      if (xhr.status == 404)
        delete this.pendingResumableUploads_[resumeId];
      callback(null, error);
    } else if (xhr.status == 308)
      this.processResumableUploadResponse_(info.sessionUrl, xhr, info);
    else
      callback(new GoogleDriveEntry(JSON.parse(xhr.responseText), this));
  }.bind(this));
};

/**
 * Send a xxx.list request and handle multi page results.
 * @param {string} method HTTP method to use.
 * @param {string} url The URL of the request.
 * @param {object} options Options for this list request, such as maxmimum
 *     number of results.
 * @param {XHRDetails} xhr_options XHR options for this request.
 * @param {function} callback Called with complete result on success, partial
 *     result or null on error with error information.
 * @param {object} multiPageOptions_ Used internally by this method. Do not
 *     supply it when you call this method.
 */
GoogleDrive.prototype.sendListRequest_ = function(method, url, options,
    xhr_options, callback, multiPageOptions_) {
  var maxResults;
  // TODO: Add maxResultsPerRequest (changes.list is likely to fail with
  // maxResults == 1000).
  if (options.maxResults)
    maxResults = Math.min(options.maxResults, this.DRIVE_API_MAX_RESULTS);
  else
    maxResults = this.DRIVE_API_MAX_RESULTS;

  if (!xhr_options.queryParameters)
    xhr_options.queryParameters = {};
  // Some list requests doesn't support maxResults (eg. properties).
  if (!options.oneTimeRequest)
    xhr_options.queryParameters.maxResults = maxResults;

  var fields = '';
  if (options.fields) {
    fields = options.fields;
    // nextPageToken is required for multi-page list requests.
    if (fields.indexOf('nextPageToken') == -1 && !options.oneTimeRequest)
      fields = 'nextPageToken,' + fields;
  }
  if (options.itemsFields) {
    if (fields)
      fields += ',';
    fields += 'items(' + options.itemsFields + ')';
  }
  if (fields)
    xhr_options.queryParameters.fields = fields;

  if (!multiPageOptions_)
    multiPageOptions_ = {responseSoFar: null};
  if (multiPageOptions_.nextPageToken)
    xhr_options.queryParameters.pageToken = multiPageOptions_.nextPageToken;

  this.sendDriveRequest_(method, url, xhr_options, function(xhr, error) {
    if (error)
      callback(multiPageOptions_.responseSoFar, error);
    else {
      var response = JSON.parse(xhr.responseText);
      var items = response.items;
      if (multiPageOptions_.responseSoFar)
        multiPageOptions_.responseSoFar.items =
            multiPageOptions_.responseSoFar.items.concat(items);
      else
        multiPageOptions_.responseSoFar = response;
      if (options.maxResults || options.oneTimeRequest)
        callback(multiPageOptions_.responseSoFar);
      else if (response.nextPageToken) {
        multiPageOptions_.nextPageToken = response.nextPageToken;
        this.sendListRequest_(method, url, options, xhr_options, callback,
            multiPageOptions_);
      } else
        callback(multiPageOptions_.responseSoFar);
    }
  }.bind(this));
};

/**
 * Upload a file to Google Drive.
 * @param {object} metadata File metadata such as description, title, etc.
 * @param {Blob|File} content File content as a Blob.
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
 * @param {object} options
 * @param {function} callback Called with GoogleDriveEntry objects.
 */
GoogleDrive.prototype.getAll = function(options, callback) {
  // TODO opt_options -> options/xhr_options.
  var list_options = {fields: ''};
  var xhr_options = {queryParameters: {}};
  if (options.q)
    xhr_options.queryParameters.q = options.q;
  list_options.itemsFields = options.fields || this.fields_.files;
  this.sendListRequest_('GET', this.DRIVE_API_FILES_BASE_URL, list_options,
      xhr_options, function(result, error) {
    callback(result.items.map(function(item) {
      return new GoogleDriveEntry(item, this);
    }.bind(this)), error);
  }.bind(this));
};

/**
 * Get basic information of this Drive account, including user information,
 * quota usage, latest change id, etc.
 * @param {function} callback Called with an About Resource.
 */
GoogleDrive.prototype.getAccountInfo = function(callback) {
  this.sendDriveRequest_('GET', this.DRIVE_API_ABOUT_URL,
      {expectedStatus: [200]}, function(xhr, error) {
    if (error)
      callback(null, error);
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
  this.sendDriveRequest_('GET', url, {queryParameters: {visibility:
      isPublic ? 'PUBLIC' : 'PRIVATE'}, expectedStatus: [200]},
      function(xhr, error) {
    if (error)
      callback(null, error);
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
  this.sendDriveRequest_('POST', url, {body: JSON.stringify({
      key: propertyKey,
      value: value,
      visibility: isPublic ? 'PUBLIC' : 'PRIVATE'
  }), contentType: 'application/json',
      expectedStatus: [200]}, function(xhr, error) {
    if (error)
      callback(null, error);
    else
      callback(JSON.parse(xhr.responseText));
  }.bind(this));
};

GoogleDrive.prototype.getChanges = function(options, callback) {
  this.sendListRequest_('GET',
                       this.DRIVE_API_CHANGES_BASE_URL,
                       {
                         fields: 'largestChangeId',
                         itemsFields: 'id,fileId,deleted,file'
                       },
                       {
                         queryParameters: {
                           startChangeId: options.startChangeId
                         }
                       },
                       callback);
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
      {responseType: 'blob', expectedStatus: [200, 206]}, function(xhr, error) {
        if (error)
          callback(null, error);
        else if (xhr.status == 200 || xhr.status == 206)
          callback(xhr.response);
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
}
var d = new GoogleDrive();
