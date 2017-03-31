import 'aws-sdk/dist/aws-sdk';
const AWS = window.AWS;

class TomboFSAWSClient {
  constructor(userId, appId) {
    this.userId = userId;
    this.appId = appId;
    this.bucket = 'tombofs.development';
    AWS.config.region = 'us-west-2';
  }

  getCredential() {
    return new Promise((resolve, reject) => {
      // FIXME: This method should be implemented by XHR
    });
  }

  userPathPrefix() {
    return `${this.userId}/`;
  }

  appPathPrefix() {
    return `${this.userPathPrefix()}${this.appId}/`;
  }

  getObject(key) {
    return new Promise((resolve, reject) => {
      this.s3.getObject({
        Bucket: this.bucket,
        Key: this.appPathPrefix() + key,
      }, (err, data) => {
        if (err) { return reject(err); }
        resolve(data);
      });
    });
  }

  putObject(key, body) {
    return new Promise((resolve, reject) => {
      this.s3.putObject({
        Bucket: this.bucket,
        Key: this.appPathPrefix() + key,
        Body: body
      }, (err, data) => {
        if (err) { return reject(err); }
        resolve(data);
      });
    });
  }

  deleteObject(key) {
    return new Promise((resolve, reject) => {
      this.s3.deleteObject({
        Bucket: this.bucket,
        Key: this.appPathPrefix() + key
        // TODO: Support VersionId
      }, (err, data) => {
        if (err) { return reject(err); }
        resolve(data);
      });
    });
  }

  deleteObjects(keys) {
    return new Promise((resolve, reject) => {
      const objects = keys.map((key) => {
        return {
          Key: this.appPathPrefix() + key
          // TODO: Support VersionId
        };
      });
      this.s3.deleteObjects({
        Bucket: this.bucket,
        Delete: {
          Objects: objects
        }
      }, (err, data) => {
        if (err) { return reject(err); }
        resolve(data);
      });
    });
  }

  listObjects(prefix) {
    return new Promise((resolve, reject) => {
      let params = {
        Bucket: this.bucket,
        Delimiter: '/',
        Prefix: this.appPathPrefix() + prefix
      };

      let contents = [];

      this.s3.listObjects(params).eachPage((err, data) => {
        if (err) { return reject(err); }
        if (data === null) { return resolve(contents); }
        contents = contents.concat(data.Contents);
      });
    });
  }

  pathToKey(path) {
    return `entries${path}`;
  }

  getFile(path) {
    return getObject(this.pathToKey(path));
  }

  putFile(path, content) {
    return putObject(this.pathToKey(path), content);
  }

  deleteFiles(paths) {
    return deleteObjects(paths.map(this.pathToKey));
  }

  getManifest() {
    // This manifest file contains entries per mountpoint
    return getObject('tombofs.manifest').then((data) => {
      return JSON.parse(data);
    }).catch((err) => {
      // FIXME: handle 404
      console.log(err);
    });
  }

  putManifest(content) {
    return putObject('tombofs.manifest', JSON.stringify(content)).then((data) => {
      return JSON.parse(data);
    });
  }
}

module.exports = TomboFSAWSClient;
