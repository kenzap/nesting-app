var __concavemanNS = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // node_modules/point-in-polygon/flat.js
  var require_flat = __commonJS({
    "node_modules/point-in-polygon/flat.js"(exports, module) {
      module.exports = function pointInPolygonFlat(point, vs, start, end) {
        var x = point[0], y = point[1];
        var inside2 = false;
        if (start === void 0) start = 0;
        if (end === void 0) end = vs.length;
        var len = (end - start) / 2;
        for (var i = 0, j = len - 1; i < len; j = i++) {
          var xi = vs[start + i * 2 + 0], yi = vs[start + i * 2 + 1];
          var xj = vs[start + j * 2 + 0], yj = vs[start + j * 2 + 1];
          var intersect = yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi;
          if (intersect) inside2 = !inside2;
        }
        return inside2;
      };
    }
  });

  // node_modules/point-in-polygon/nested.js
  var require_nested = __commonJS({
    "node_modules/point-in-polygon/nested.js"(exports, module) {
      module.exports = function pointInPolygonNested(point, vs, start, end) {
        var x = point[0], y = point[1];
        var inside2 = false;
        if (start === void 0) start = 0;
        if (end === void 0) end = vs.length;
        var len = end - start;
        for (var i = 0, j = len - 1; i < len; j = i++) {
          var xi = vs[i + start][0], yi = vs[i + start][1];
          var xj = vs[j + start][0], yj = vs[j + start][1];
          var intersect = yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi;
          if (intersect) inside2 = !inside2;
        }
        return inside2;
      };
    }
  });

  // node_modules/point-in-polygon/index.js
  var require_point_in_polygon = __commonJS({
    "node_modules/point-in-polygon/index.js"(exports, module) {
      var pointInPolygonFlat = require_flat();
      var pointInPolygonNested = require_nested();
      module.exports = function pointInPolygon2(point, vs, start, end) {
        if (vs.length > 0 && Array.isArray(vs[0])) {
          return pointInPolygonNested(point, vs, start, end);
        } else {
          return pointInPolygonFlat(point, vs, start, end);
        }
      };
      module.exports.nested = pointInPolygonNested;
      module.exports.flat = pointInPolygonFlat;
    }
  });

  // node_modules/concaveman/index.js
  var index_exports = {};
  __export(index_exports, {
    default: () => concaveman
  });

  // node_modules/quickselect/index.js
  function quickselect(arr, k, left = 0, right = arr.length - 1, compare = defaultCompare) {
    while (right > left) {
      if (right - left > 600) {
        const n = right - left + 1;
        const m = k - left + 1;
        const z = Math.log(n);
        const s = 0.5 * Math.exp(2 * z / 3);
        const sd = 0.5 * Math.sqrt(z * s * (n - s) / n) * (m - n / 2 < 0 ? -1 : 1);
        const newLeft = Math.max(left, Math.floor(k - m * s / n + sd));
        const newRight = Math.min(right, Math.floor(k + (n - m) * s / n + sd));
        quickselect(arr, k, newLeft, newRight, compare);
      }
      const t = arr[k];
      let i = left;
      let j = right;
      swap(arr, left, k);
      if (compare(arr[right], t) > 0) swap(arr, left, right);
      while (i < j) {
        swap(arr, i, j);
        i++;
        j--;
        while (compare(arr[i], t) < 0) i++;
        while (compare(arr[j], t) > 0) j--;
      }
      if (compare(arr[left], t) === 0) swap(arr, left, j);
      else {
        j++;
        swap(arr, j, right);
      }
      if (j <= k) left = j + 1;
      if (k <= j) right = j - 1;
    }
  }
  function swap(arr, i, j) {
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  function defaultCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // node_modules/rbush/index.js
  var RBush = class {
    constructor(maxEntries = 9) {
      this._maxEntries = Math.max(4, maxEntries);
      this._minEntries = Math.max(2, Math.ceil(this._maxEntries * 0.4));
      this.clear();
    }
    all() {
      return this._all(this.data, []);
    }
    search(bbox) {
      let node = this.data;
      const result = [];
      if (!intersects(bbox, node)) return result;
      const toBBox = this.toBBox;
      const nodesToSearch = [];
      while (node) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          const childBBox = node.leaf ? toBBox(child) : child;
          if (intersects(bbox, childBBox)) {
            if (node.leaf) result.push(child);
            else if (contains(bbox, childBBox)) this._all(child, result);
            else nodesToSearch.push(child);
          }
        }
        node = nodesToSearch.pop();
      }
      return result;
    }
    collides(bbox) {
      let node = this.data;
      if (!intersects(bbox, node)) return false;
      const nodesToSearch = [];
      while (node) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          const childBBox = node.leaf ? this.toBBox(child) : child;
          if (intersects(bbox, childBBox)) {
            if (node.leaf || contains(bbox, childBBox)) return true;
            nodesToSearch.push(child);
          }
        }
        node = nodesToSearch.pop();
      }
      return false;
    }
    load(data) {
      if (!(data && data.length)) return this;
      if (data.length < this._minEntries) {
        for (let i = 0; i < data.length; i++) {
          this.insert(data[i]);
        }
        return this;
      }
      let node = this._build(data.slice(), 0, data.length - 1, 0);
      if (!this.data.children.length) {
        this.data = node;
      } else if (this.data.height === node.height) {
        this._splitRoot(this.data, node);
      } else {
        if (this.data.height < node.height) {
          const tmpNode = this.data;
          this.data = node;
          node = tmpNode;
        }
        this._insert(node, this.data.height - node.height - 1, true);
      }
      return this;
    }
    insert(item) {
      if (item) this._insert(item, this.data.height - 1);
      return this;
    }
    clear() {
      this.data = createNode([]);
      return this;
    }
    remove(item, equalsFn) {
      if (!item) return this;
      let node = this.data;
      const bbox = this.toBBox(item);
      const path = [];
      const indexes = [];
      let i, parent, goingUp;
      while (node || path.length) {
        if (!node) {
          node = path.pop();
          parent = path[path.length - 1];
          i = indexes.pop();
          goingUp = true;
        }
        if (node.leaf) {
          const index = findItem(item, node.children, equalsFn);
          if (index !== -1) {
            node.children.splice(index, 1);
            path.push(node);
            this._condense(path);
            return this;
          }
        }
        if (!goingUp && !node.leaf && contains(node, bbox)) {
          path.push(node);
          indexes.push(i);
          i = 0;
          parent = node;
          node = node.children[0];
        } else if (parent) {
          i++;
          node = parent.children[i];
          goingUp = false;
        } else node = null;
      }
      return this;
    }
    toBBox(item) {
      return item;
    }
    compareMinX(a, b) {
      return a.minX - b.minX;
    }
    compareMinY(a, b) {
      return a.minY - b.minY;
    }
    toJSON() {
      return this.data;
    }
    fromJSON(data) {
      this.data = data;
      return this;
    }
    _all(node, result) {
      const nodesToSearch = [];
      while (node) {
        if (node.leaf) result.push(...node.children);
        else nodesToSearch.push(...node.children);
        node = nodesToSearch.pop();
      }
      return result;
    }
    _build(items, left, right, height) {
      const N = right - left + 1;
      let M = this._maxEntries;
      let node;
      if (N <= M) {
        node = createNode(items.slice(left, right + 1));
        calcBBox(node, this.toBBox);
        return node;
      }
      if (!height) {
        height = Math.ceil(Math.log(N) / Math.log(M));
        M = Math.ceil(N / Math.pow(M, height - 1));
      }
      node = createNode([]);
      node.leaf = false;
      node.height = height;
      const N2 = Math.ceil(N / M);
      const N1 = N2 * Math.ceil(Math.sqrt(M));
      multiSelect(items, left, right, N1, this.compareMinX);
      for (let i = left; i <= right; i += N1) {
        const right2 = Math.min(i + N1 - 1, right);
        multiSelect(items, i, right2, N2, this.compareMinY);
        for (let j = i; j <= right2; j += N2) {
          const right3 = Math.min(j + N2 - 1, right2);
          node.children.push(this._build(items, j, right3, height - 1));
        }
      }
      calcBBox(node, this.toBBox);
      return node;
    }
    _chooseSubtree(bbox, node, level, path) {
      while (true) {
        path.push(node);
        if (node.leaf || path.length - 1 === level) break;
        let minArea = Infinity;
        let minEnlargement = Infinity;
        let targetNode;
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          const area = bboxArea(child);
          const enlargement = enlargedArea(bbox, child) - area;
          if (enlargement < minEnlargement) {
            minEnlargement = enlargement;
            minArea = area < minArea ? area : minArea;
            targetNode = child;
          } else if (enlargement === minEnlargement) {
            if (area < minArea) {
              minArea = area;
              targetNode = child;
            }
          }
        }
        node = targetNode || node.children[0];
      }
      return node;
    }
    _insert(item, level, isNode) {
      const bbox = isNode ? item : this.toBBox(item);
      const insertPath = [];
      const node = this._chooseSubtree(bbox, this.data, level, insertPath);
      node.children.push(item);
      extend(node, bbox);
      while (level >= 0) {
        if (insertPath[level].children.length > this._maxEntries) {
          this._split(insertPath, level);
          level--;
        } else break;
      }
      this._adjustParentBBoxes(bbox, insertPath, level);
    }
    // split overflowed node into two
    _split(insertPath, level) {
      const node = insertPath[level];
      const M = node.children.length;
      const m = this._minEntries;
      this._chooseSplitAxis(node, m, M);
      const splitIndex = this._chooseSplitIndex(node, m, M);
      const newNode = createNode(node.children.splice(splitIndex, node.children.length - splitIndex));
      newNode.height = node.height;
      newNode.leaf = node.leaf;
      calcBBox(node, this.toBBox);
      calcBBox(newNode, this.toBBox);
      if (level) insertPath[level - 1].children.push(newNode);
      else this._splitRoot(node, newNode);
    }
    _splitRoot(node, newNode) {
      this.data = createNode([node, newNode]);
      this.data.height = node.height + 1;
      this.data.leaf = false;
      calcBBox(this.data, this.toBBox);
    }
    _chooseSplitIndex(node, m, M) {
      let index;
      let minOverlap = Infinity;
      let minArea = Infinity;
      for (let i = m; i <= M - m; i++) {
        const bbox1 = distBBox(node, 0, i, this.toBBox);
        const bbox2 = distBBox(node, i, M, this.toBBox);
        const overlap = intersectionArea(bbox1, bbox2);
        const area = bboxArea(bbox1) + bboxArea(bbox2);
        if (overlap < minOverlap) {
          minOverlap = overlap;
          index = i;
          minArea = area < minArea ? area : minArea;
        } else if (overlap === minOverlap) {
          if (area < minArea) {
            minArea = area;
            index = i;
          }
        }
      }
      return index || M - m;
    }
    // sorts node children by the best axis for split
    _chooseSplitAxis(node, m, M) {
      const compareMinX = node.leaf ? this.compareMinX : compareNodeMinX;
      const compareMinY = node.leaf ? this.compareMinY : compareNodeMinY;
      const xMargin = this._allDistMargin(node, m, M, compareMinX);
      const yMargin = this._allDistMargin(node, m, M, compareMinY);
      if (xMargin < yMargin) node.children.sort(compareMinX);
    }
    // total margin of all possible split distributions where each node is at least m full
    _allDistMargin(node, m, M, compare) {
      node.children.sort(compare);
      const toBBox = this.toBBox;
      const leftBBox = distBBox(node, 0, m, toBBox);
      const rightBBox = distBBox(node, M - m, M, toBBox);
      let margin = bboxMargin(leftBBox) + bboxMargin(rightBBox);
      for (let i = m; i < M - m; i++) {
        const child = node.children[i];
        extend(leftBBox, node.leaf ? toBBox(child) : child);
        margin += bboxMargin(leftBBox);
      }
      for (let i = M - m - 1; i >= m; i--) {
        const child = node.children[i];
        extend(rightBBox, node.leaf ? toBBox(child) : child);
        margin += bboxMargin(rightBBox);
      }
      return margin;
    }
    _adjustParentBBoxes(bbox, path, level) {
      for (let i = level; i >= 0; i--) {
        extend(path[i], bbox);
      }
    }
    _condense(path) {
      for (let i = path.length - 1, siblings; i >= 0; i--) {
        if (path[i].children.length === 0) {
          if (i > 0) {
            siblings = path[i - 1].children;
            siblings.splice(siblings.indexOf(path[i]), 1);
          } else this.clear();
        } else calcBBox(path[i], this.toBBox);
      }
    }
  };
  function findItem(item, items, equalsFn) {
    if (!equalsFn) return items.indexOf(item);
    for (let i = 0; i < items.length; i++) {
      if (equalsFn(item, items[i])) return i;
    }
    return -1;
  }
  function calcBBox(node, toBBox) {
    distBBox(node, 0, node.children.length, toBBox, node);
  }
  function distBBox(node, k, p, toBBox, destNode) {
    if (!destNode) destNode = createNode(null);
    destNode.minX = Infinity;
    destNode.minY = Infinity;
    destNode.maxX = -Infinity;
    destNode.maxY = -Infinity;
    for (let i = k; i < p; i++) {
      const child = node.children[i];
      extend(destNode, node.leaf ? toBBox(child) : child);
    }
    return destNode;
  }
  function extend(a, b) {
    a.minX = Math.min(a.minX, b.minX);
    a.minY = Math.min(a.minY, b.minY);
    a.maxX = Math.max(a.maxX, b.maxX);
    a.maxY = Math.max(a.maxY, b.maxY);
    return a;
  }
  function compareNodeMinX(a, b) {
    return a.minX - b.minX;
  }
  function compareNodeMinY(a, b) {
    return a.minY - b.minY;
  }
  function bboxArea(a) {
    return (a.maxX - a.minX) * (a.maxY - a.minY);
  }
  function bboxMargin(a) {
    return a.maxX - a.minX + (a.maxY - a.minY);
  }
  function enlargedArea(a, b) {
    return (Math.max(b.maxX, a.maxX) - Math.min(b.minX, a.minX)) * (Math.max(b.maxY, a.maxY) - Math.min(b.minY, a.minY));
  }
  function intersectionArea(a, b) {
    const minX = Math.max(a.minX, b.minX);
    const minY = Math.max(a.minY, b.minY);
    const maxX = Math.min(a.maxX, b.maxX);
    const maxY = Math.min(a.maxY, b.maxY);
    return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  }
  function contains(a, b) {
    return a.minX <= b.minX && a.minY <= b.minY && b.maxX <= a.maxX && b.maxY <= a.maxY;
  }
  function intersects(a, b) {
    return b.minX <= a.maxX && b.minY <= a.maxY && b.maxX >= a.minX && b.maxY >= a.minY;
  }
  function createNode(children) {
    return {
      children,
      height: 1,
      leaf: true,
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
  }
  function multiSelect(arr, left, right, n, compare) {
    const stack = [left, right];
    while (stack.length) {
      right = stack.pop();
      left = stack.pop();
      if (right - left <= n) continue;
      const mid = left + Math.ceil((right - left) / n / 2) * n;
      quickselect(arr, mid, left, right, compare);
      stack.push(left, mid, mid, right);
    }
  }

  // node_modules/tinyqueue/index.js
  var TinyQueue = class {
    constructor(data = [], compare = (a, b) => a < b ? -1 : a > b ? 1 : 0) {
      this.data = data;
      this.length = this.data.length;
      this.compare = compare;
      if (this.length > 0) {
        for (let i = (this.length >> 1) - 1; i >= 0; i--) this._down(i);
      }
    }
    push(item) {
      this.data.push(item);
      this._up(this.length++);
    }
    pop() {
      if (this.length === 0) return void 0;
      const top = this.data[0];
      const bottom = this.data.pop();
      if (--this.length > 0) {
        this.data[0] = bottom;
        this._down(0);
      }
      return top;
    }
    peek() {
      return this.data[0];
    }
    _up(pos) {
      const { data, compare } = this;
      const item = data[pos];
      while (pos > 0) {
        const parent = pos - 1 >> 1;
        const current = data[parent];
        if (compare(item, current) >= 0) break;
        data[pos] = current;
        pos = parent;
      }
      data[pos] = item;
    }
    _down(pos) {
      const { data, compare } = this;
      const halfLength = this.length >> 1;
      const item = data[pos];
      while (pos < halfLength) {
        let bestChild = (pos << 1) + 1;
        const right = bestChild + 1;
        if (right < this.length && compare(data[right], data[bestChild]) < 0) {
          bestChild = right;
        }
        if (compare(data[bestChild], item) >= 0) break;
        data[pos] = data[bestChild];
        pos = bestChild;
      }
      data[pos] = item;
    }
  };

  // node_modules/concaveman/index.js
  var import_point_in_polygon = __toESM(require_point_in_polygon(), 1);

  // node_modules/robust-predicates/esm/util.js
  var epsilon = 11102230246251565e-32;
  var splitter = 134217729;
  var resulterrbound = (3 + 8 * epsilon) * epsilon;
  function sum(elen, e, flen, f, h) {
    let Q, Qnew, hh, bvirt;
    let enow = e[0];
    let fnow = f[0];
    let eindex = 0;
    let findex = 0;
    if (fnow > enow === fnow > -enow) {
      Q = enow;
      enow = e[++eindex];
    } else {
      Q = fnow;
      fnow = f[++findex];
    }
    let hindex = 0;
    if (eindex < elen && findex < flen) {
      if (fnow > enow === fnow > -enow) {
        Qnew = enow + Q;
        hh = Q - (Qnew - enow);
        enow = e[++eindex];
      } else {
        Qnew = fnow + Q;
        hh = Q - (Qnew - fnow);
        fnow = f[++findex];
      }
      Q = Qnew;
      if (hh !== 0) {
        h[hindex++] = hh;
      }
      while (eindex < elen && findex < flen) {
        if (fnow > enow === fnow > -enow) {
          Qnew = Q + enow;
          bvirt = Qnew - Q;
          hh = Q - (Qnew - bvirt) + (enow - bvirt);
          enow = e[++eindex];
        } else {
          Qnew = Q + fnow;
          bvirt = Qnew - Q;
          hh = Q - (Qnew - bvirt) + (fnow - bvirt);
          fnow = f[++findex];
        }
        Q = Qnew;
        if (hh !== 0) {
          h[hindex++] = hh;
        }
      }
    }
    while (eindex < elen) {
      Qnew = Q + enow;
      bvirt = Qnew - Q;
      hh = Q - (Qnew - bvirt) + (enow - bvirt);
      enow = e[++eindex];
      Q = Qnew;
      if (hh !== 0) {
        h[hindex++] = hh;
      }
    }
    while (findex < flen) {
      Qnew = Q + fnow;
      bvirt = Qnew - Q;
      hh = Q - (Qnew - bvirt) + (fnow - bvirt);
      fnow = f[++findex];
      Q = Qnew;
      if (hh !== 0) {
        h[hindex++] = hh;
      }
    }
    if (Q !== 0 || hindex === 0) {
      h[hindex++] = Q;
    }
    return hindex;
  }
  function estimate(elen, e) {
    let Q = e[0];
    for (let i = 1; i < elen; i++) Q += e[i];
    return Q;
  }
  function vec(n) {
    return new Float64Array(n);
  }

  // node_modules/robust-predicates/esm/orient2d.js
  var ccwerrboundA = (3 + 16 * epsilon) * epsilon;
  var ccwerrboundB = (2 + 12 * epsilon) * epsilon;
  var ccwerrboundC = (9 + 64 * epsilon) * epsilon * epsilon;
  var B = vec(4);
  var C1 = vec(8);
  var C2 = vec(12);
  var D = vec(16);
  var u = vec(4);
  function orient2dadapt(ax, ay, bx, by, cx, cy, detsum) {
    let acxtail, acytail, bcxtail, bcytail;
    let bvirt, c, ahi, alo, bhi, blo, _i, _j, _0, s1, s0, t1, t0, u32;
    const acx = ax - cx;
    const bcx = bx - cx;
    const acy = ay - cy;
    const bcy = by - cy;
    s1 = acx * bcy;
    c = splitter * acx;
    ahi = c - (c - acx);
    alo = acx - ahi;
    c = splitter * bcy;
    bhi = c - (c - bcy);
    blo = bcy - bhi;
    s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    t1 = acy * bcx;
    c = splitter * acy;
    ahi = c - (c - acy);
    alo = acy - ahi;
    c = splitter * bcx;
    bhi = c - (c - bcx);
    blo = bcx - bhi;
    t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    _i = s0 - t0;
    bvirt = s0 - _i;
    B[0] = s0 - (_i + bvirt) + (bvirt - t0);
    _j = s1 + _i;
    bvirt = _j - s1;
    _0 = s1 - (_j - bvirt) + (_i - bvirt);
    _i = _0 - t1;
    bvirt = _0 - _i;
    B[1] = _0 - (_i + bvirt) + (bvirt - t1);
    u32 = _j + _i;
    bvirt = u32 - _j;
    B[2] = _j - (u32 - bvirt) + (_i - bvirt);
    B[3] = u32;
    let det = estimate(4, B);
    let errbound = ccwerrboundB * detsum;
    if (det >= errbound || -det >= errbound) {
      return det;
    }
    bvirt = ax - acx;
    acxtail = ax - (acx + bvirt) + (bvirt - cx);
    bvirt = bx - bcx;
    bcxtail = bx - (bcx + bvirt) + (bvirt - cx);
    bvirt = ay - acy;
    acytail = ay - (acy + bvirt) + (bvirt - cy);
    bvirt = by - bcy;
    bcytail = by - (bcy + bvirt) + (bvirt - cy);
    if (acxtail === 0 && acytail === 0 && bcxtail === 0 && bcytail === 0) {
      return det;
    }
    errbound = ccwerrboundC * detsum + resulterrbound * Math.abs(det);
    det += acx * bcytail + bcy * acxtail - (acy * bcxtail + bcx * acytail);
    if (det >= errbound || -det >= errbound) return det;
    s1 = acxtail * bcy;
    c = splitter * acxtail;
    ahi = c - (c - acxtail);
    alo = acxtail - ahi;
    c = splitter * bcy;
    bhi = c - (c - bcy);
    blo = bcy - bhi;
    s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    t1 = acytail * bcx;
    c = splitter * acytail;
    ahi = c - (c - acytail);
    alo = acytail - ahi;
    c = splitter * bcx;
    bhi = c - (c - bcx);
    blo = bcx - bhi;
    t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    _i = s0 - t0;
    bvirt = s0 - _i;
    u[0] = s0 - (_i + bvirt) + (bvirt - t0);
    _j = s1 + _i;
    bvirt = _j - s1;
    _0 = s1 - (_j - bvirt) + (_i - bvirt);
    _i = _0 - t1;
    bvirt = _0 - _i;
    u[1] = _0 - (_i + bvirt) + (bvirt - t1);
    u32 = _j + _i;
    bvirt = u32 - _j;
    u[2] = _j - (u32 - bvirt) + (_i - bvirt);
    u[3] = u32;
    const C1len = sum(4, B, 4, u, C1);
    s1 = acx * bcytail;
    c = splitter * acx;
    ahi = c - (c - acx);
    alo = acx - ahi;
    c = splitter * bcytail;
    bhi = c - (c - bcytail);
    blo = bcytail - bhi;
    s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    t1 = acy * bcxtail;
    c = splitter * acy;
    ahi = c - (c - acy);
    alo = acy - ahi;
    c = splitter * bcxtail;
    bhi = c - (c - bcxtail);
    blo = bcxtail - bhi;
    t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    _i = s0 - t0;
    bvirt = s0 - _i;
    u[0] = s0 - (_i + bvirt) + (bvirt - t0);
    _j = s1 + _i;
    bvirt = _j - s1;
    _0 = s1 - (_j - bvirt) + (_i - bvirt);
    _i = _0 - t1;
    bvirt = _0 - _i;
    u[1] = _0 - (_i + bvirt) + (bvirt - t1);
    u32 = _j + _i;
    bvirt = u32 - _j;
    u[2] = _j - (u32 - bvirt) + (_i - bvirt);
    u[3] = u32;
    const C2len = sum(C1len, C1, 4, u, C2);
    s1 = acxtail * bcytail;
    c = splitter * acxtail;
    ahi = c - (c - acxtail);
    alo = acxtail - ahi;
    c = splitter * bcytail;
    bhi = c - (c - bcytail);
    blo = bcytail - bhi;
    s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    t1 = acytail * bcxtail;
    c = splitter * acytail;
    ahi = c - (c - acytail);
    alo = acytail - ahi;
    c = splitter * bcxtail;
    bhi = c - (c - bcxtail);
    blo = bcxtail - bhi;
    t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    _i = s0 - t0;
    bvirt = s0 - _i;
    u[0] = s0 - (_i + bvirt) + (bvirt - t0);
    _j = s1 + _i;
    bvirt = _j - s1;
    _0 = s1 - (_j - bvirt) + (_i - bvirt);
    _i = _0 - t1;
    bvirt = _0 - _i;
    u[1] = _0 - (_i + bvirt) + (bvirt - t1);
    u32 = _j + _i;
    bvirt = u32 - _j;
    u[2] = _j - (u32 - bvirt) + (_i - bvirt);
    u[3] = u32;
    const Dlen = sum(C2len, C2, 4, u, D);
    return D[Dlen - 1];
  }
  function orient2d(ax, ay, bx, by, cx, cy) {
    const detleft = (ay - cy) * (bx - cx);
    const detright = (ax - cx) * (by - cy);
    const det = detleft - detright;
    const detsum = Math.abs(detleft + detright);
    if (Math.abs(det) >= ccwerrboundA * detsum) return det;
    return -orient2dadapt(ax, ay, bx, by, cx, cy, detsum);
  }

  // node_modules/robust-predicates/esm/orient3d.js
  var o3derrboundA = (7 + 56 * epsilon) * epsilon;
  var o3derrboundB = (3 + 28 * epsilon) * epsilon;
  var o3derrboundC = (26 + 288 * epsilon) * epsilon * epsilon;
  var bc = vec(4);
  var ca = vec(4);
  var ab = vec(4);
  var at_b = vec(4);
  var at_c = vec(4);
  var bt_c = vec(4);
  var bt_a = vec(4);
  var ct_a = vec(4);
  var ct_b = vec(4);
  var bct = vec(8);
  var cat = vec(8);
  var abt = vec(8);
  var u2 = vec(4);
  var _8 = vec(8);
  var _8b = vec(8);
  var _16 = vec(16);
  var _12 = vec(12);
  var fin = vec(192);
  var fin2 = vec(192);

  // node_modules/robust-predicates/esm/incircle.js
  var iccerrboundA = (10 + 96 * epsilon) * epsilon;
  var iccerrboundB = (4 + 48 * epsilon) * epsilon;
  var iccerrboundC = (44 + 576 * epsilon) * epsilon * epsilon;
  var bc2 = vec(4);
  var ca2 = vec(4);
  var ab2 = vec(4);
  var aa = vec(4);
  var bb = vec(4);
  var cc = vec(4);
  var u3 = vec(4);
  var v = vec(4);
  var axtbc = vec(8);
  var aytbc = vec(8);
  var bxtca = vec(8);
  var bytca = vec(8);
  var cxtab = vec(8);
  var cytab = vec(8);
  var abt2 = vec(8);
  var bct2 = vec(8);
  var cat2 = vec(8);
  var abtt = vec(4);
  var bctt = vec(4);
  var catt = vec(4);
  var _82 = vec(8);
  var _162 = vec(16);
  var _16b = vec(16);
  var _16c = vec(16);
  var _32 = vec(32);
  var _32b = vec(32);
  var _48 = vec(48);
  var _64 = vec(64);
  var fin3 = vec(1152);
  var fin22 = vec(1152);

  // node_modules/robust-predicates/esm/insphere.js
  var isperrboundA = (16 + 224 * epsilon) * epsilon;
  var isperrboundB = (5 + 72 * epsilon) * epsilon;
  var isperrboundC = (71 + 1408 * epsilon) * epsilon * epsilon;
  var ab3 = vec(4);
  var bc3 = vec(4);
  var cd = vec(4);
  var de = vec(4);
  var ea = vec(4);
  var ac = vec(4);
  var bd = vec(4);
  var ce = vec(4);
  var da = vec(4);
  var eb = vec(4);
  var abc = vec(24);
  var bcd = vec(24);
  var cde = vec(24);
  var dea = vec(24);
  var eab = vec(24);
  var abd = vec(24);
  var bce = vec(24);
  var cda = vec(24);
  var deb = vec(24);
  var eac = vec(24);
  var adet = vec(1152);
  var bdet = vec(1152);
  var cdet = vec(1152);
  var ddet = vec(1152);
  var edet = vec(1152);
  var abdet = vec(2304);
  var cddet = vec(2304);
  var cdedet = vec(3456);
  var deter = vec(5760);
  var _83 = vec(8);
  var _8b2 = vec(8);
  var _8c = vec(8);
  var _163 = vec(16);
  var _24 = vec(24);
  var _482 = vec(48);
  var _48b = vec(48);
  var _96 = vec(96);
  var _192 = vec(192);
  var _384x = vec(384);
  var _384y = vec(384);
  var _384z = vec(384);
  var _768 = vec(768);
  var xdet = vec(96);
  var ydet = vec(96);
  var zdet = vec(96);
  var fin4 = vec(1152);

  // node_modules/concaveman/index.js
  function concaveman(points, concavity, lengthThreshold) {
    concavity = Math.max(0, concavity === void 0 ? 2 : concavity);
    lengthThreshold = lengthThreshold || 0;
    const hull = fastConvexHull(points);
    const tree = new RBush(16);
    tree.toBBox = function(a) {
      return {
        minX: a[0],
        minY: a[1],
        maxX: a[0],
        maxY: a[1]
      };
    };
    tree.compareMinX = function(a, b) {
      return a[0] - b[0];
    };
    tree.compareMinY = function(a, b) {
      return a[1] - b[1];
    };
    tree.load(points);
    const queue = [];
    let last;
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i];
      tree.remove(p);
      last = insertNode(p, last);
      queue.push(last);
    }
    const segTree = new RBush(16);
    for (let i = 0; i < queue.length; i++) segTree.insert(updateBBox(queue[i]));
    const sqConcavity = concavity * concavity;
    const sqLenThreshold = lengthThreshold * lengthThreshold;
    while (queue.length) {
      const node2 = queue.shift();
      const a = node2.p;
      const b = node2.next.p;
      const sqLen = getSqDist(a, b);
      if (sqLen < sqLenThreshold) continue;
      const maxSqLen = sqLen / sqConcavity;
      const p = findCandidate(tree, node2.prev.p, a, b, node2.next.next.p, maxSqLen, segTree);
      if (p && Math.min(getSqDist(p, a), getSqDist(p, b)) <= maxSqLen) {
        queue.push(node2);
        queue.push(insertNode(p, node2));
        tree.remove(p);
        segTree.remove(node2);
        segTree.insert(updateBBox(node2));
        segTree.insert(updateBBox(node2.next));
      }
    }
    let node = last;
    const concave = [];
    do {
      concave.push(node.p);
      node = node.next;
    } while (node !== last);
    concave.push(node.p);
    return concave;
  }
  function findCandidate(tree, a, b, c, d, maxDist, segTree) {
    const queue = new TinyQueue([], compareDist);
    let node = tree.data;
    while (node) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const dist = node.leaf ? sqSegDist(child, b, c) : sqSegBoxDist(b, c, child);
        if (dist > maxDist) continue;
        queue.push({
          node: child,
          dist
        });
      }
      while (queue.length && !queue.peek().node.children) {
        const item = queue.pop();
        const p = item.node;
        const d0 = sqSegDist(p, a, b);
        const d1 = sqSegDist(p, c, d);
        if (item.dist < d0 && item.dist < d1 && noIntersections(b, p, segTree) && noIntersections(c, p, segTree)) return p;
      }
      node = queue.pop();
      if (node) node = node.node;
    }
    return null;
  }
  function compareDist(a, b) {
    return a.dist - b.dist;
  }
  function sqSegBoxDist(a, b, bbox) {
    if (inside(a, bbox) || inside(b, bbox)) return 0;
    const d1 = sqSegSegDist(a[0], a[1], b[0], b[1], bbox.minX, bbox.minY, bbox.maxX, bbox.minY);
    if (d1 === 0) return 0;
    const d2 = sqSegSegDist(a[0], a[1], b[0], b[1], bbox.minX, bbox.minY, bbox.minX, bbox.maxY);
    if (d2 === 0) return 0;
    const d3 = sqSegSegDist(a[0], a[1], b[0], b[1], bbox.maxX, bbox.minY, bbox.maxX, bbox.maxY);
    if (d3 === 0) return 0;
    const d4 = sqSegSegDist(a[0], a[1], b[0], b[1], bbox.minX, bbox.maxY, bbox.maxX, bbox.maxY);
    if (d4 === 0) return 0;
    return Math.min(d1, d2, d3, d4);
  }
  function inside(a, bbox) {
    return a[0] >= bbox.minX && a[0] <= bbox.maxX && a[1] >= bbox.minY && a[1] <= bbox.maxY;
  }
  function noIntersections(a, b, segTree) {
    const minX = Math.min(a[0], b[0]);
    const minY = Math.min(a[1], b[1]);
    const maxX = Math.max(a[0], b[0]);
    const maxY = Math.max(a[1], b[1]);
    const edges = segTree.search({ minX, minY, maxX, maxY });
    for (let i = 0; i < edges.length; i++) {
      if (intersects2(edges[i].p, edges[i].next.p, a, b)) return false;
    }
    return true;
  }
  function cross(p1, p2, p3) {
    return orient2d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  }
  function intersects2(p1, q1, p2, q2) {
    return p1 !== q2 && q1 !== p2 && cross(p1, q1, p2) > 0 !== cross(p1, q1, q2) > 0 && cross(p2, q2, p1) > 0 !== cross(p2, q2, q1) > 0;
  }
  function updateBBox(node) {
    const p1 = node.p;
    const p2 = node.next.p;
    node.minX = Math.min(p1[0], p2[0]);
    node.minY = Math.min(p1[1], p2[1]);
    node.maxX = Math.max(p1[0], p2[0]);
    node.maxY = Math.max(p1[1], p2[1]);
    return node;
  }
  function fastConvexHull(points) {
    let left = points[0];
    let top = points[0];
    let right = points[0];
    let bottom = points[0];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p[0] < left[0]) left = p;
      if (p[0] > right[0]) right = p;
      if (p[1] < top[1]) top = p;
      if (p[1] > bottom[1]) bottom = p;
    }
    const cull = [left, top, right, bottom];
    const filtered = cull.slice();
    for (let i = 0; i < points.length; i++) {
      if (!(0, import_point_in_polygon.default)(points[i], cull)) filtered.push(points[i]);
    }
    return convexHull(filtered);
  }
  function insertNode(p, prev) {
    const node = {
      p,
      prev: null,
      next: null,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0
    };
    if (!prev) {
      node.prev = node;
      node.next = node;
    } else {
      node.next = prev.next;
      node.prev = prev;
      prev.next.prev = node;
      prev.next = node;
    }
    return node;
  }
  function getSqDist(p1, p2) {
    const dx = p1[0] - p2[0], dy = p1[1] - p2[1];
    return dx * dx + dy * dy;
  }
  function sqSegDist(p, p1, p2) {
    let x = p1[0], y = p1[1], dx = p2[0] - x, dy = p2[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = p2[0];
        y = p2[1];
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }
    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
  }
  function sqSegSegDist(x0, y0, x1, y1, x2, y2, x3, y3) {
    const ux = x1 - x0;
    const uy = y1 - y0;
    const vx = x3 - x2;
    const vy = y3 - y2;
    const wx = x0 - x2;
    const wy = y0 - y2;
    const a = ux * ux + uy * uy;
    const b = ux * vx + uy * vy;
    const c = vx * vx + vy * vy;
    const d = ux * wx + uy * wy;
    const e = vx * wx + vy * wy;
    const D2 = a * c - b * b;
    let sN, tN;
    let sD = D2;
    let tD = D2;
    if (D2 === 0) {
      sN = 0;
      sD = 1;
      tN = e;
      tD = c;
    } else {
      sN = b * e - c * d;
      tN = a * e - b * d;
      if (sN < 0) {
        sN = 0;
        tN = e;
        tD = c;
      } else if (sN > sD) {
        sN = sD;
        tN = e + b;
        tD = c;
      }
    }
    if (tN < 0) {
      tN = 0;
      if (-d < 0) sN = 0;
      else if (-d > a) sN = sD;
      else {
        sN = -d;
        sD = a;
      }
    } else if (tN > tD) {
      tN = tD;
      if (-d + b < 0) sN = 0;
      else if (-d + b > a) sN = sD;
      else {
        sN = -d + b;
        sD = a;
      }
    }
    const sc = sN === 0 ? 0 : sN / sD;
    const tc = tN === 0 ? 0 : tN / tD;
    const cx = (1 - sc) * x0 + sc * x1;
    const cy = (1 - sc) * y0 + sc * y1;
    const cx2 = (1 - tc) * x2 + tc * x3;
    const cy2 = (1 - tc) * y2 + tc * y3;
    const dx = cx2 - cx;
    const dy = cy2 - cy;
    return dx * dx + dy * dy;
  }
  function compareByX(a, b) {
    return a[0] === b[0] ? a[1] - b[1] : a[0] - b[0];
  }
  function convexHull(points) {
    points.sort(compareByX);
    const lower = [];
    for (let i = 0; i < points.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], points[i]) <= 0) {
        lower.pop();
      }
      lower.push(points[i]);
    }
    const upper = [];
    for (let ii = points.length - 1; ii >= 0; ii--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points[ii]) <= 0) {
        upper.pop();
      }
      upper.push(points[ii]);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }
  return __toCommonJS(index_exports);
})();
window.concaveman=(__concavemanNS&&(__concavemanNS.default||__concavemanNS));
