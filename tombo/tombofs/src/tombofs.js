'use strict';

const TomboFSAWSClient = require('./tombofs-aws-client.js');

module.exports = {
  // NOTE: based on library_memfs.js b6012fb7ba259e67dd7cd4f87377de0cbdb04eec
  //       disable some eslint rules to keep original source lines.
  /* eslint-disable no-unused-vars, no-empty */
  ops_table: null,
  mount: function (mount) {
    if (Module.tombo && Module.tombo.userId && Module.tombo.appId) {
      // NOTE: Module.tombo.apiURI could be null when running without Tombo platform.
      TOMBOFS.AWSClient = new TomboFSAWSClient(Module.tombo.userId, Module.tombo.appId, Module.tombo.apiURI);
      TOMBOFS.DB_STORE_NAME = 'TOMBOFS_' + Module.tombo.appId;
    } else {
      TOMBOFS.DB_STORE_NAME = 'TOMBOFS_' + '00000000-0000-0000-0000-000000000000';
    }
    return TOMBOFS.createNode(null, '/', EMSCRIPTEN_CDEFINE_S_IFDIR | 511 /* 0777 */, 0);
  },
  createNode: function (parent, name, mode, dev) {
    if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
      // no supported
      throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    if (!TOMBOFS.ops_table) {
      TOMBOFS.ops_table = {
        dir: {
          node: {
            getattr: TOMBOFS.node_ops.getattr,
            setattr: TOMBOFS.node_ops.setattr,
            lookup: TOMBOFS.node_ops.lookup,
            mknod: TOMBOFS.node_ops.mknod,
            rename: TOMBOFS.node_ops.rename,
            unlink: TOMBOFS.node_ops.unlink,
            rmdir: TOMBOFS.node_ops.rmdir,
            readdir: TOMBOFS.node_ops.readdir,
            symlink: TOMBOFS.node_ops.symlink
          },
          stream: {
            llseek: TOMBOFS.stream_ops.llseek
          }
        },
        file: {
          node: {
            getattr: TOMBOFS.node_ops.getattr,
            setattr: TOMBOFS.node_ops.setattr
          },
          stream: {
            llseek: TOMBOFS.stream_ops.llseek,
            read: TOMBOFS.stream_ops.read,
            write: TOMBOFS.stream_ops.write,
            allocate: TOMBOFS.stream_ops.allocate,
            mmap: TOMBOFS.stream_ops.mmap,
            msync: TOMBOFS.stream_ops.msync
          }
        },
        link: {
          node: {
            getattr: TOMBOFS.node_ops.getattr,
            setattr: TOMBOFS.node_ops.setattr,
            readlink: TOMBOFS.node_ops.readlink
          },
          stream: {}
        },
        chrdev: {
          node: {
            getattr: TOMBOFS.node_ops.getattr,
            setattr: TOMBOFS.node_ops.setattr
          },
          stream: FS.chrdev_stream_ops
        }
      };
    }
    let node = FS.createNode(parent, name, mode, dev);
    if (FS.isDir(node.mode)) {
      node.node_ops = TOMBOFS.ops_table.dir.node;
      node.stream_ops = TOMBOFS.ops_table.dir.stream;
      node.contents = {};
    } else if (FS.isFile(node.mode)) {
      node.node_ops = TOMBOFS.ops_table.file.node;
      node.stream_ops = TOMBOFS.ops_table.file.stream;
      node.usedBytes = 0; // The actual number of bytes used in the typed array, as opposed to contents.length which gives the whole capacity.
      // When the byte data of the file is populated, this will point to either a typed array, or a normal JS array. Typed arrays are preferred
      // for performance, and used by default. However, typed arrays are not resizable like normal JS arrays are, so there is a small disk size
      // penalty involved for appending file writes that continuously grow a file similar to std::vector capacity vs used -scheme.
      node.contents = null;
    } else if (FS.isLink(node.mode)) {
      node.node_ops = TOMBOFS.ops_table.link.node;
      node.stream_ops = TOMBOFS.ops_table.link.stream;
    } else if (FS.isChrdev(node.mode)) {
      node.node_ops = TOMBOFS.ops_table.chrdev.node;
      node.stream_ops = TOMBOFS.ops_table.chrdev.stream;
    }
    node.timestamp = Date.now();
    // add the new node to the parent
    if (parent) {
      parent.contents[name] = node;
    }
    return node;
  },

  // Given a file node, returns its file data converted to a regular JS array. You should treat this as read-only.
  getFileDataAsRegularArray: function (node) {
    if (node.contents && node.contents.subarray) {
      let arr = [];
      for (let i = 0; i < node.usedBytes; ++i) arr.push(node.contents[i]);
      return arr; // Returns a copy of the original data.
    }
    return node.contents; // No-op, the file contents are already in a JS array. Return as-is.
  },

  // Given a file node, returns its file data converted to a typed array.
  getFileDataAsTypedArray: function (node) {
    if (!node.contents) return new Uint8Array;
    if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes); // Make sure to not return excess unused bytes.
    return new Uint8Array(node.contents);
  },

  // Allocates a new backing store for the given node so that it can fit at least newSize amount of bytes.
  // May allocate more, to provide automatic geometric increase and amortized linear performance appending writes.
  // Never shrinks the storage.
  expandFileStorage: function (node, newCapacity) {
    if (!node.contents || node.contents.subarray) { // Keep using a typed array if creating a new storage, or if old one was a typed array as well.
      let prevCapacity = node.contents ? node.contents.length : 0;
      if (prevCapacity >= newCapacity) return; // No need to expand, the storage was already large enough.
      // Don't expand strictly to the given requested limit if it's only a very small increase, but instead geometrically grow capacity.
      // For small filesizes (<1MB), perform size*2 geometric increase, but for large sizes, do a much more conservative size*1.125 increase to
      // avoid overshooting the allocation cap by a very large margin.
      let CAPACITY_DOUBLING_MAX = 1024 * 1024;
      newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2.0 : 1.125)) | 0);
      if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256); // At minimum allocate 256b for each file when expanding.
      let oldContents = node.contents;
      node.contents = new Uint8Array(newCapacity); // Allocate new storage.
      if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0); // Copy old data over to the new storage.
      return;
    }
    // Not using a typed array to back the file storage. Use a standard JS array instead.
    if (!node.contents && newCapacity > 0) node.contents = [];
    while (node.contents.length < newCapacity) node.contents.push(0);
  },

  // Performs an exact resize of the backing file storage to the given size, if the size is not exactly this, the storage is fully reallocated.
  resizeFileStorage: function (node, newSize) {
    if (node.usedBytes == newSize) return;
    if (newSize == 0) {
      node.contents = null; // Fully decommit when requesting a resize to zero.
      node.usedBytes = 0;
      return;
    }
    if (!node.contents || node.contents.subarray) { // Resize a typed array if that is being used as the backing store.
      let oldContents = node.contents;
      node.contents = new Uint8Array(new ArrayBuffer(newSize)); // Allocate new storage.
      if (oldContents) {
        node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes))); // Copy old data over to the new storage.
      }
      node.usedBytes = newSize;
      return;
    }
    // Backing with a JS array.
    if (!node.contents) node.contents = [];
    if (node.contents.length > newSize) node.contents.length = newSize;
    else while (node.contents.length < newSize) node.contents.push(0);
    node.usedBytes = newSize;
  },

  node_ops: {
    getattr: function (node) {
      let attr = {};
      // device numbers reuse inode numbers.
      attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
      attr.ino = node.id;
      attr.mode = node.mode;
      attr.nlink = 1;
      attr.uid = 0;
      attr.gid = 0;
      attr.rdev = node.rdev;
      if (FS.isDir(node.mode)) {
        attr.size = 4096;
      } else if (FS.isFile(node.mode)) {
        attr.size = node.usedBytes;
      } else if (FS.isLink(node.mode)) {
        attr.size = node.link.length;
      } else {
        attr.size = 0;
      }
      attr.atime = new Date(node.timestamp);
      attr.mtime = new Date(node.timestamp);
      attr.ctime = new Date(node.timestamp);
      // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
      //       but this is not required by the standard.
      attr.blksize = 4096;
      attr.blocks = Math.ceil(attr.size / attr.blksize);
      return attr;
    },
    setattr: function (node, attr) {
      if (attr.mode !== undefined) {
        node.mode = attr.mode;
      }
      if (attr.timestamp !== undefined) {
        node.timestamp = attr.timestamp;
      }
      if (attr.size !== undefined) {
        TOMBOFS.resizeFileStorage(node, attr.size);
      }
    },
    lookup: function (parent, name, ex) {
      if (ex) return;
      throw FS.genericErrors[ERRNO_CODES.ENOENT];
    },
    mknod: function (parent, name, mode, dev) {
      return TOMBOFS.createNode(parent, name, mode, dev);
    },
    rename: function (old_node, new_dir, new_name) {
      // if we're overwriting a directory at new_name, make sure it's empty.
      if (FS.isDir(old_node.mode)) {
        let new_node;
        try {
          new_node = FS.lookupNode(new_dir, new_name);
        } catch (e) {
        }
        if (new_node) {
          for (let i in new_node.contents) {
            throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
          }
        }
      }
      // do the internal rewiring
      delete old_node.parent.contents[old_node.name];
      old_node.name = new_name;
      new_dir.contents[new_name] = old_node;
      old_node.parent = new_dir;
    },
    unlink: function (parent, name) {
      delete parent.contents[name];
    },
    rmdir: function (parent, name) {
      let node = FS.lookupNode(parent, name);
      for (let i in node.contents) {
        throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
      }
      delete parent.contents[name];
    },
    readdir: function (node) {
      let entries = ['.', '..']
      for (let key in node.contents) {
        if (!node.contents.hasOwnProperty(key)) {
          continue;
        }
        entries.push(key);
      }
      return entries;
    },
    symlink: function (parent, newname, oldpath) {
      let node = TOMBOFS.createNode(parent, newname, 511 /* 0777 */ | EMSCRIPTEN_CDEFINE_S_IFLNK, 0);
      node.link = oldpath;
      return node;
    },
    readlink: function (node) {
      if (!FS.isLink(node.mode)) {
        throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
      }
      return node.link;
    },
  },
  stream_ops: {
    read: function (stream, buffer, offset, length, position) {
      let contents = stream.node.contents;
      if (position >= stream.node.usedBytes) return 0;
      let size = Math.min(stream.node.usedBytes - position, length);
      assert(size >= 0);
      if (size > 8 && contents.subarray) { // non-trivial, and typed array
        buffer.set(contents.subarray(position, position + size), offset);
      } else {
        for (let i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
      }
      return size;
    },

    // Writes the byte range (buffer[offset], buffer[offset+length]) to offset 'position' into the file pointed by 'stream'
    // canOwn: A boolean that tells if this function can take ownership of the passed in buffer from the subbuffer portion
    //         that the typed array view 'buffer' points to. The underlying ArrayBuffer can be larger than that, but
    //         canOwn=true will not take ownership of the portion outside the bytes addressed by the view. This means that
    //         with canOwn=true, creating a copy of the bytes is avoided, but the caller shouldn't touch the passed in range
    //         of bytes anymore since their contents now represent file data inside the filesystem.
    write: function (stream, buffer, offset, length, position, canOwn) {
      if (!length) return 0;
      let node = stream.node;
      node.timestamp = Date.now();

      if (buffer.subarray && (!node.contents || node.contents.subarray)) { // This write is from a typed array to a typed array?
        if (canOwn) {
          assert(position === 0, 'canOwn must imply no weird position inside the file');
          node.contents = buffer.subarray(offset, offset + length);
          node.usedBytes = length;
          return length;
        } else if (node.usedBytes === 0 && position === 0) { // If this is a simple first write to an empty file, do a fast set since we don't need to care about old data.
          node.contents = new Uint8Array(buffer.subarray(offset, offset + length));
          node.usedBytes = length;
          return length;
        } else if (position + length <= node.usedBytes) { // Writing to an already allocated and used subrange of the file?
          node.contents.set(buffer.subarray(offset, offset + length), position);
          return length;
        }
      }

      // Appending to an existing file and we need to reallocate, or source data did not come as a typed array.
      TOMBOFS.expandFileStorage(node, position+length);
      if (node.contents.subarray && buffer.subarray) node.contents.set(buffer.subarray(offset, offset + length), position); // Use typed array write if available.
      else {
        for (let i = 0; i < length; i++) {
         node.contents[position + i] = buffer[offset + i]; // Or fall back to manual write if not.
        }
      }
      node.usedBytes = Math.max(node.usedBytes, position+length);
      return length;
    },

    llseek: function (stream, offset, whence) {
      let position = offset;
      if (whence === 1) {  // SEEK_CUR.
        position += stream.position;
      } else if (whence === 2) {  // SEEK_END.
        if (FS.isFile(stream.node.mode)) {
          position += stream.node.usedBytes;
        }
      }
      if (position < 0) {
        throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
      }
      return position;
    },
    allocate: function (stream, offset, length) {
      TOMBOFS.expandFileStorage(stream.node, offset + length);
      stream.node.usedBytes = Math.max(stream.node.usedBytes, offset + length);
    },
    mmap: function (stream, buffer, offset, length, position, prot, flags) {
      if (!FS.isFile(stream.node.mode)) {
        throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
      }
      let ptr;
      let allocated;
      let contents = stream.node.contents;
      // Only make a new copy when MAP_PRIVATE is specified.
      if ( !(flags & EMSCRIPTEN_CDEFINE_MAP_PRIVATE) &&
            (contents.buffer === buffer || contents.buffer === buffer.buffer) ) {
        // We can't emulate MAP_SHARED when the file is not backed by the buffer
        // we're mapping to (e.g. the HEAP buffer).
        allocated = false;
        ptr = contents.byteOffset;
      } else {
        // Try to avoid unnecessary slices.
        if (position > 0 || position + length < stream.node.usedBytes) {
          if (contents.subarray) {
            contents = contents.subarray(position, position + length);
          } else {
            contents = Array.prototype.slice.call(contents, position, position + length);
          }
        }
        allocated = true;
        ptr = _malloc(length);
        if (!ptr) {
          throw new FS.ErrnoError(ERRNO_CODES.ENOMEM);
        }
        buffer.set(contents, ptr);
      }
      return { ptr: ptr, allocated: allocated };
    },
    msync: function (stream, buffer, offset, length, mmapFlags) {
      if (!FS.isFile(stream.node.mode)) {
        throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
      }
      if (mmapFlags & EMSCRIPTEN_CDEFINE_MAP_PRIVATE) {
        // MAP_PRIVATE calls need not to be synced back to underlying fs
        return 0;
      }

      let bytesWritten = TOMBOFS.stream_ops.write(stream, buffer, 0, length, offset, false);
      // should we check if bytesWritten and length are the same?
      return 0;
    }
  },
  /* eslint-enable no-unused-vars, no-empty */

  // sync to IndexedDB
  // NOTE: based on library_idbfs.js 0941e0187b4ae203a7d93d45b6aaf58f737b9614
  dbs: {},
  indexedDB: function () {
    if (typeof indexedDB !== 'undefined') return indexedDB;
    let ret = null;
    if (typeof window === 'object') ret = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    assert(ret, 'TOMBOFS used, but indexedDB not supported');
    return ret;
  },
  DB_VERSION: 1,
  DB_STORE_NAME: 'TOMBOFS', // could be overwritten in mount()
  syncfs: function (mount, populate, callback) {
    // serialize syncfs() even if mount points are different
    const lockedSyncfs = () => {
      // mutex
      if (TOMBOFS.syncingFS) {
        setTimeout(() => {
          lockedSyncfs();
        }, 0);
        return;
      }
      TOMBOFS.syncingFS = true;

      console.log(`syncfs: ${mount.mountpoint} ${populate}`);

      let promises = [
        TOMBOFS.heartbeat(),
        TOMBOFS.getLocalSet(mount),
        TOMBOFS.getRemoteSet(mount),
      ];
      if (TOMBOFS.AWSClient) {
        promises.push(TOMBOFS.getTomboSet(mount));
      }

      Promise.all(promises).then((values) => {
        if (TOMBOFS.AWSClient && !values[0]) {
          // heartbeat fails with TOMBOFS.AWSClient
          return callback(new Error('heartbeat fails'));
        }

        if (populate) {
          if (TOMBOFS.AWSClient) {
            // Tombo => IndexedDB => Memory
            return TOMBOFS.reconcile(values[3], values[2]).then(() => {
              return TOMBOFS.reconcile(values[2], values[1]);
            }).then(() => {
              TOMBOFS.syncingFS = false;
              callback(null);
            });
          } else {
            // IndexedDB => Memory
            return TOMBOFS.reconcile(values[2], values[1]).then(() => {
              TOMBOFS.syncingFS = false;
              callback(null);
            });
          }
        } else {
          // Memory => IndexedDB
          return TOMBOFS.reconcile(values[1], values[2]).then(() => {
            if (TOMBOFS.AWSClient) {
              // Memory => Tombo
              // Note: IndexedDB transaction may not have finished yet,
              //       So reconcile from Memory, not IndexedDB.
              return TOMBOFS.reconcile(values[1], values[3], callback);
            } else {
              return null;
            }
          }).then(() => {
            TOMBOFS.syncingFS = false;
            callback(null);
          });
        }
      }).catch((err) => {
        console.log(`syncfs: ERROR ${err}`);
        console.log(err);
        // Delete TOMBOFS AWSClient
        if (TOMBOFS.AWSClient) {
          delete TOMBOFS.AWSClient;
        }
        TOMBOFS.syncingFS = false;
        callback(err);
      });
    };
    lockedSyncfs();
  },
  getDB: function (name, callback) {
    // check the cache first
    let db = TOMBOFS.dbs[name];
    if (db) {
      return callback(null, db);
    }

    let req;
    try {
      req = TOMBOFS.indexedDB().open(name, TOMBOFS.DB_VERSION);
    } catch (e) {
      return callback(e);
    }
    if (!req) {
      return callback('Unable to connect to IndexedDB');
    }
    req.onupgradeneeded = function (e) {
      let db = e.target.result;
      let transaction = e.target.transaction;

      let fileStore;

      if (db.objectStoreNames.contains(TOMBOFS.DB_STORE_NAME)) {
        fileStore = transaction.objectStore(TOMBOFS.DB_STORE_NAME);
      } else {
        fileStore = db.createObjectStore(TOMBOFS.DB_STORE_NAME);
      }

      if (!fileStore.indexNames.contains('timestamp')) {
        fileStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = function () {
      db = req.result;

      // add to the cache
      TOMBOFS.dbs[name] = db;
      callback(null, db);
    };
    req.onerror = function (e) {
      callback(this.error);
      e.preventDefault();
    };
  },
  getLocalSet: function (mount) {
    let entries = {};

    let isRealDir = (p) => {
      return p !== '.' && p !== '..';
    };
    let toAbsolute = (root) => {
      return (p) => {
        return PATH.join2(root, p);
      };
    };

    let check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));

    return new Promise((resolve, _reject) => {
      while (check.length) {
        let path = check.pop();
        let stat;

        stat = FS.stat(path);

        if (FS.isDir(stat.mode)) {
          check.push.apply(check, FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
        }

        entries[path] = { timestamp: stat.mtime };
      }

      resolve({ type: 'local', entries: entries });
    });
  },
  getRemoteSet: function (mount) {
    let entries = {};

    return new Promise((resolve, reject) => {
      TOMBOFS.getDB(mount.mountpoint, (err, db) => {
        if (err) return reject(err);

        let transaction = db.transaction([TOMBOFS.DB_STORE_NAME], 'readonly');
        transaction.onerror = function (e) {
          reject(this.error);
          e.preventDefault();
        };

        let store = transaction.objectStore(TOMBOFS.DB_STORE_NAME);
        let index = store.index('timestamp');

        index.openKeyCursor().onsuccess = function (event) {
          let cursor = event.target.result;

          if (!cursor) {
            return resolve({ type: 'remote', db: db, entries: entries });
          }

          entries[cursor.primaryKey] = { timestamp: cursor.key };

          cursor.continue();
        };
      });
    });
  },
  getTomboManifest: function () {
    // The latest manifest in stored in TOMBOFS.manifest
    // At the first time, it is fetched by remote server.
    const lockedGetTomboManifest = (resolve, reject) => {
      if (TOMBOFS.manifest) {
        return resolve(TOMBOFS.manifest);
      }
      if (!TOMBOFS.AWSClient) {
        return resolve(null);
      }
      // mutex
      if (TOMBOFS.fetchingManifest) {
        setTimeout(() => {
          lockedGetTomboManifest(resolve, reject);
        }, 0);
        return;
      }
      TOMBOFS.fetchingManifest = true;

      console.log('Fetch manifest');

      TOMBOFS.AWSClient.getManifest().then((manifest) => {
        TOMBOFS.manifest = manifest;
        TOMBOFS.fetchingManifest = false;
        resolve(manifest);
      });
    };
    return new Promise(lockedGetTomboManifest);
  },
  getTomboSet: function (mount) {
    if (!TOMBOFS.AWSClient) { return Promise.reject(new Error('AWSClient is null')); }

    return TOMBOFS.getTomboManifest().then((manifest) => {
      if (!manifest.mountpoints) { return Promise.reject(new Error('manifest must have the key `mountpoints`')); }
      if (!manifest.mountpoints.hasOwnProperty(mount.mountpoint)) {
        console.log(`Initialize manifest for mountpoint ${mount.mountpoint}`)
        manifest.mountpoints[mount.mountpoint] = {
          entries: {}
        };
      }
      const manifestOnMountpoint = manifest.mountpoints[mount.mountpoint];
      if (!manifestOnMountpoint.entries) { return Promise.reject(new Error(`manifest for the mountpoint ${mount.mountpoint} must have the key 'entries'`)); }

      let entries = {};
      for (const path of Object.keys(manifestOnMountpoint.entries)) {
        const value = manifestOnMountpoint.entries[path];

        entries[path] = {
          timestamp: value.mtime
        }
      }

      return {
        type: 'tombo',
        manifest: manifest,
        mountpoint: mount.mountpoint,
        entries: entries
      };
    });
  },
  loadLocalEntry: function (path) {
    return new Promise((resolve, reject) => {
      let stat, node;

      let lookup = FS.lookupPath(path);
      node = lookup.node;
      stat = FS.stat(path);

      if (FS.isDir(stat.mode)) {
        return resolve({ timestamp: stat.mtime, mode: stat.mode });
      } else if (FS.isFile(stat.mode)) {
        // Performance consideration: storing a normal JavaScript array to a IndexedDB is much slower than storing a typed array.
        // Therefore always convert the file contents to a typed array first before writing the data to IndexedDB.
        node.contents = MEMFS.getFileDataAsTypedArray(node);
        return resolve({ timestamp: stat.mtime, mode: stat.mode, contents: node.contents });
      } else {
        return reject(new Error('node type not supported'));
      }
    });
  },
  storeLocalEntry: function (path, entry) {
    return new Promise((resolve, reject) => {
      if (FS.isDir(entry.mode)) {
        FS.mkdir(path, entry.mode);
      } else if (FS.isFile(entry.mode)) {
        FS.writeFile(path, entry.contents, { encoding: 'binary', canOwn: true });
      } else {
        return reject(new Error('node type not supported'));
      }

      FS.chmod(path, entry.mode);
      FS.utime(path, entry.timestamp, entry.timestamp);

      resolve();
    });
  },
  removeLocalEntry: function (path) {
    return new Promise((resolve, _reject) => {
      FS.lookupPath(path);
      let stat = FS.stat(path);

      if (FS.isDir(stat.mode)) {
        FS.rmdir(path);
      } else if (FS.isFile(stat.mode)) {
        FS.unlink(path);
      }

      resolve();
    });
  },
  loadRemoteEntry: function (store, path) {
    return new Promise((resolve, reject) => {
      let req = store.get(path);
      req.onsuccess = function (event) { resolve(event.target.result); };
      req.onerror = function (e) {
        reject(this.error);
        e.preventDefault();
      };
    });
  },
  storeRemoteEntry: function (store, path, entry) {
    return new Promise((resolve, reject) => {
      let req = store.put(entry, path);
      req.onsuccess = function () { resolve(); };
      req.onerror = function (e) {
        reject(this.error);
        e.preventDefault();
      };
    });
  },
  removeRemoteEntry: function (store, path) {
    return new Promise((resolve, reject) => {
      let req = store.delete(path);
      req.onsuccess = function () { resolve(); };
      req.onerror = function (e) {
        reject(this.error);
        e.preventDefault();
      };
    });
  },
  loadTomboEntry: function (manifest, mountpoint, path) {
    console.groupCollapsed(`loadTomboEntry: ${path}`);
    console.log({
      manifest: manifest,
      path: path
    });
    console.groupEnd();
    const manifestEntry = manifest.mountpoints[mountpoint].entries[path];
    if (!manifestEntry) {
      return Promise.reject(new Error(`loadTomboEntry(): Cannot get meta information from manifest for the path: ${path}`));
    }
    let timestamp = new Date();
    // NOTE: manifest have mtime with UNIX epoch on a millisecond basis
    timestamp.setTime(manifestEntry.mtime);
    let entry = {
      mode: manifestEntry.mode,
      timestamp: timestamp
    };
    // Directory is not saved on AWS
    if (FS.isDir(manifestEntry.mode)) {
      return new Promise((resolve, _reject) => {
        resolve(entry);
      });
    }
    return TOMBOFS.AWSClient.getFile(path, entry).then((data) => {
      // TODO: Check data.Body with manifestEntry.size or hash
      entry.contents = new Uint8Array(data.Body);
      return entry;
    });
  },
  storeTomboEntry: function (path, entry) {
    console.groupCollapsed(`storeTomboEntry: ${path}`);
    console.log({
      path: path,
      entry: entry
    });
    console.groupEnd();
    // Directory is not saved on AWS
    if (FS.isDir(entry.mode)) {
      return Promise.resolve();
    }
    return TOMBOFS.AWSClient.putFile(path, entry);
  },
  removeTomboEntries: function (entries) {
    console.groupCollapsed('removeTomboEntries:');
    console.log({
      entries: entries
    });
    console.groupEnd();

    let paths = Object.keys(entries).sort().reverse();
    if (paths.length === 0) { return Promise.resolve(); }
    paths.filter((path, _index, _array) => {
      // Since a directory is not saved on AWS, filter all the directories
      return !FS.isDir(entries[path].mode);
    });
    return TOMBOFS.AWSClient.deleteFiles(paths);
  },
  uploadTomboManifest: function () {
    console.log('uploadTomboManifest:');

    // The latest manifest in stored in TOMBOFS.manifest
    // At the first time, it is fetched by remote server.
    const lockedUploadTomboManifest = (resolve, reject) => {
      if (!TOMBOFS.AWSClient) {
        return reject(new Error('uploadTomboManifest() is called but there is no AWS client'));
      }
      // mutex
      if (TOMBOFS.fetchingManifest || TOMBOFS.uploadingManifest) {
        setTimeout(() => {
          lockedUploadTomboManifest(resolve, reject);
        }, 0);
        return;
      }
      TOMBOFS.uploadingManifest = true;
      TOMBOFS.manifest.mtime = new Date().getTime();

      TOMBOFS.AWSClient.putManifest(TOMBOFS.manifest).then(() => {
        TOMBOFS.uploadingManifest = false;
        resolve();
      });
    };
    return new Promise(lockedUploadTomboManifest);
  },
  heartbeat: function () {
    if (!TOMBOFS.AWSClient) {
      return Promise.resolve(false);
    }

    return TOMBOFS.AWSClient.heartbeat().then(() => {
      return true;
    }).catch((err) => {
      TOMBOFS.AWSClient = null;
      let message = TOMBOFS.messages.failHeartbeat[ENV.LOCALE || 'en'];
      if (Module.setStatusAndHalt) {
        // Tombo shell has the function Module.setStatusAndHalt()
        Module.setStatusAndHalt(message);
      } else {
        Module.setStatus(message);
        throw new Error(message);
      }
      return false;
    });
  },
  reconcile: function (src, dst) {
    console.groupCollapsed(`reconcile: from ${src.type} (${Object.keys(src.entries).length}) to ${dst.type} (${Object.keys(dst.entries).length})`);
    console.log({
      src: src,
      dst: dst
    });
    console.groupEnd();

    let total = 0;

    let create = [];
    Object.keys(src.entries).forEach((key) => {
      let e = src.entries[key];
      let e2 = dst.entries[key];
      if (!e2 || e.timestamp > e2.timestamp) {
        create.push(key);
        total++;
      }
    });
    // sort paths in ascending order so directory entries are created
    // before the files inside them
    create = create.sort();

    let remove = [];
    Object.keys(dst.entries).forEach((key) => {
      let e = src.entries[key];
      if (!e) {
        remove.push(key);
        total++;
      }
    });
    // sort paths in descending order so files are deleted before their
    // parent directories
    remove = remove.sort().reverse();

    return new Promise((resolve, reject) => {
      if (!total) {
        console.log('reconcile END: nothing to do');
        return resolve();
      }

      let completed = 0;
      let db, transaction, store;
      if (src.type === 'remote') {
        db = src.db
      } else if (dst.type === 'remote') {
        db = dst.db
      }

      let idbtransaction = () => {
        transaction = db.transaction([TOMBOFS.DB_STORE_NAME], 'readwrite');
        store = transaction.objectStore(TOMBOFS.DB_STORE_NAME);

        transaction.onerror = function (e) {
          done(this.error);
          e.preventDefault();
        };
      };

      let done = (err) => {
        if (err) {
          if (done.errored) { return; }
          done.errored = true;
          return reject(err);
        }
        if (++completed < total) { return; }

        // now all tasks are completed

        console.groupCollapsed(`reconcile END: from ${src.type} (${Object.keys(src.entries).length}) to ${dst.type} (${Object.keys(dst.entries).length})`);
        console.log({
          src: src,
          dst: dst
        });
        console.groupEnd();

        // When reject() is already called, do nothing
        if (done.errored) { return; }

        // the end of reconcile() except the destination is Tombo
        if (dst.type !== 'tombo') { return resolve(); }

        // update manifest
        let manifestEntries = dst.manifest.mountpoints[dst.mountpoint].entries;
        let entriesToBeRemovedAfterManifestUpload = {};
        console.groupCollapsed('reconcile Update manifest:');
        console.log(manifestEntries);
        create.forEach((path) => {
          if (manifestEntries[path]) {
            // file is updated, so we must delete the old file from S3
            entriesToBeRemovedAfterManifestUpload[path] = manifestEntries[path];
          }
          const entry = storedTomboEntries[path];
          manifestEntries[path] = {
            mode: entry.mode,
            mtime: entry.timestamp.getTime()
          };
        });
        remove.forEach((path) => {
          // so we must delete the actual file from S3
          if (!manifestEntries[path]) {
            return reject(new Error(`Cannot find manifest entry for ${path}`));
          }
          entriesToBeRemovedAfterManifestUpload[path] = manifestEntries[path];
          delete manifestEntries[path];
        });
        console.log(manifestEntries);
        console.groupEnd();

        TOMBOFS.uploadTomboManifest().then(() => {
          if (Object.keys(entriesToBeRemovedAfterManifestUpload).length === 0) {
            return;
          }
          // delete all the removed files in S3
          return TOMBOFS.removeTomboEntries(entriesToBeRemovedAfterManifestUpload);
        }).then(() => {
          resolve();
        }).catch((err) => {
          reject(err);
        });
      };

      let storedTomboEntries = {}; // for deleting files in failure
      create.forEach((path) => {
        switch (dst.type) {
        case 'local':
          switch (src.type) {
          case 'remote':
            idbtransaction();
            TOMBOFS.loadRemoteEntry(store, path).then((entry) => {
              return TOMBOFS.storeLocalEntry(path, entry);
            }).then(() => {
              done();
            }).catch((err) => {
              done(err);
            });
            break;
          case 'tombo':
            TOMBOFS.loadTomboEntry(src.manifest, src.mountpoint, path).then((entry) => {
              return TOMBOFS.storeLocalEntry(path, entry);
            }).then(() => {
              done();
            }).catch((err) => {
              done(err);
            });
            break;
          default:
            console.log(`reconcile() doesn't support ${src.type} into ${dst.type}`);
          }
          break;
        case 'remote':
          switch (src.type) {
          case 'local':
            TOMBOFS.loadLocalEntry(path).then((entry) => {
              idbtransaction();
              return TOMBOFS.storeRemoteEntry(store, path, entry);
            }).then(() => {
              done();
            }).catch((err) => {
              done(err);
            });
            break;
          case 'tombo':
            TOMBOFS.loadTomboEntry(src.manifest, src.mountpoint, path).then((entry) => {
              idbtransaction();
              return TOMBOFS.storeRemoteEntry(store, path, entry);
            }).then(() => {
              done();
            }).catch((err) => {
              done(err);
            });
            break;
          default:
            console.log(`reconcile() doesn't support ${src.type} into ${dst.type}`);
          }
          break;
        case 'tombo':
          switch (src.type) {
          case 'local':
            TOMBOFS.loadLocalEntry(path).then((entry) => {
              return TOMBOFS.storeTomboEntry(path, entry).then(() => {
                return entry;
              });
            }).then((entry) => {
              storedTomboEntries[path] = entry;
              done();
            }).catch((err) => {
              done(err);
            });
            break;
          case 'remote':
            idbtransaction();
            TOMBOFS.loadRemoteEntry(store, path).then((entry) => {
              return TOMBOFS.storeTomboEntry(path, entry).then(() => {
                return entry;
              });
            }).then((entry) => {
              storedTomboEntries[path] = entry;
              done();
            }).catch((err) => {
              done(err);
            });
            break;
          default:
            console.log(`reconcile() doesn't support ${src.type} into ${dst.type}`);
          }
          break;
        }
        // add entries for continuous reconcile
        dst.entries[path] = src.entries[path];
      });

      if (remove.length === 0) { return; }

      // removing entries
      switch (dst.type) {
      case 'local':
        remove.forEach((path) => {
          TOMBOFS.removeLocalEntry(path).then(() => {
            // delete entries for continuous reconcile
            delete dst.entries[path];
            done();
          });
        });
        break;
      case 'remote':
        idbtransaction();
        remove.forEach((path) => {
          TOMBOFS.removeRemoteEntry(store, path).then(() => {
            // delete entries for continuous reconcile
            delete dst.entries[path];
            done();
          });
        });
        break;
      case 'tombo':
        // Just delete entries for continuous reconcile
        // after all entries are created or removed,
        // file deletions in S3 will occur in done().
        remove.forEach((path) => {
          delete dst.entries[path]
          done();
        });
        break;
      }
    });
  },
  messages: {
    failHeartbeat: {
      en: 'This application is opened in another browser or the network connection is down. Reload the page.',
      ja: '他のプラウザでこのアプリを使用したか、ネットワーク接続が切れました。ページをリロードしてください。'
    }
  }
}
