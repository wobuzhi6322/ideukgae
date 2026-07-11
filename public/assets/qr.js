/*!
 * qr.js — 계이득 자체 포함 QR 인코더 (외부 CDN·외부 스크립트 금지 정책 준수, 단일 파일·의존성 0)
 *
 * Kazuhiko Arase의 qrcode-generator (https://github.com/kazuhikoarase/qrcode-generator,
 * MIT License) 알고리즘 구조를 기반으로 이 저장소용으로 재작성·축소한 구현.
 * 지원 범위: 바이트 모드(UTF-8) · 오류정정 레벨 M · 버전 1~10 (최대 213바이트).
 * 공개 API: window.GyeideukQR = { toCanvas(canvas, text), create(text) }
 *
 * The MIT License (MIT)
 * Copyright (c) 2009 Kazuhiko Arase
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
(function (root) {
  "use strict";

  // --- GF(256) 산술 ----------------------------------------------------------

  var EXP = new Array(256);
  var LOG = new Array(256);
  (function () {
    for (var i = 0; i < 8; i += 1) EXP[i] = 1 << i;
    for (var j = 8; j < 256; j += 1) {
      EXP[j] = EXP[j - 4] ^ EXP[j - 5] ^ EXP[j - 6] ^ EXP[j - 8];
    }
    for (var k = 0; k < 255; k += 1) LOG[EXP[k]] = k;
  })();

  function glog(n) {
    if (n < 1) throw new Error("glog(" + n + ")");
    return LOG[n];
  }

  function gexp(n) {
    while (n < 0) n += 255;
    while (n >= 255) n -= 255;
    return EXP[n];
  }

  // --- 다항식 (리드-솔로몬) -----------------------------------------------------

  function Polynomial(num, shift) {
    var offset = 0;
    while (offset < num.length && num[offset] === 0) offset += 1;
    var length = num.length - offset + shift;
    this.num = new Array(length);
    for (var i = 0; i < length; i += 1) {
      this.num[i] = i < num.length - offset ? num[i + offset] : 0;
    }
  }

  Polynomial.prototype.get = function (index) {
    return this.num[index];
  };

  Polynomial.prototype.getLength = function () {
    return this.num.length;
  };

  Polynomial.prototype.multiply = function (e) {
    var num = new Array(this.getLength() + e.getLength() - 1);
    for (var n = 0; n < num.length; n += 1) num[n] = 0;
    for (var i = 0; i < this.getLength(); i += 1) {
      var a = this.get(i);
      if (a === 0) continue;
      for (var j = 0; j < e.getLength(); j += 1) {
        var b = e.get(j);
        if (b === 0) continue;
        num[i + j] ^= gexp(glog(a) + glog(b));
      }
    }
    return new Polynomial(num, 0);
  };

  Polynomial.prototype.mod = function (e) {
    if (this.getLength() - e.getLength() < 0) return this;
    var ratio = glog(this.get(0)) - glog(e.get(0));
    var num = new Array(this.getLength());
    for (var i = 0; i < this.getLength(); i += 1) num[i] = this.get(i);
    for (var j = 0; j < e.getLength(); j += 1) {
      num[j] ^= gexp(glog(e.get(j)) + ratio);
    }
    return new Polynomial(num, 0).mod(e);
  };

  function getErrorCorrectPolynomial(ecCount) {
    var poly = new Polynomial([1], 0);
    for (var i = 0; i < ecCount; i += 1) {
      poly = poly.multiply(new Polynomial([1, gexp(i)], 0));
    }
    return poly;
  }

  // --- BCH (포맷/버전 정보) -----------------------------------------------------

  var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
  var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
  var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

  function getBCHDigit(value) {
    var digit = 0;
    while (value !== 0) {
      digit += 1;
      value >>>= 1;
    }
    return digit;
  }

  function getBCHTypeInfo(data) {
    var d = data << 10;
    while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
      d ^= G15 << (getBCHDigit(d) - getBCHDigit(G15));
    }
    return ((data << 10) | d) ^ G15_MASK;
  }

  function getBCHTypeNumber(data) {
    var d = data << 12;
    while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
      d ^= G18 << (getBCHDigit(d) - getBCHDigit(G18));
    }
    return (data << 12) | d;
  }

  // --- 버전별 상수 (오류정정 레벨 M, 버전 1~10) -----------------------------------

  // [블록 수, 블록 총 코드워드, 블록 데이터 코드워드] 반복
  var RS_BLOCKS_M = [
    [[1, 26, 16]],
    [[1, 44, 28]],
    [[1, 70, 44]],
    [[2, 50, 32]],
    [[2, 67, 43]],
    [[4, 43, 27]],
    [[4, 49, 31]],
    [[2, 60, 38], [2, 61, 39]],
    [[3, 58, 36], [2, 59, 37]],
    [[4, 69, 43], [1, 70, 44]]
  ];

  var PATTERN_POSITION = [
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50]
  ];

  // 바이트 모드·레벨 M 데이터 용량(바이트): 버전 1~10
  var BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

  var PAD0 = 0xec;
  var PAD1 = 0x11;

  function getRsBlocks(version) {
    var spec = RS_BLOCKS_M[version - 1];
    var blocks = [];
    for (var i = 0; i < spec.length; i += 1) {
      for (var j = 0; j < spec[i][0]; j += 1) {
        blocks.push({ totalCount: spec[i][1], dataCount: spec[i][2] });
      }
    }
    return blocks;
  }

  // --- 비트 버퍼 ---------------------------------------------------------------

  function BitBuffer() {
    this.buffer = [];
    this.length = 0;
  }

  BitBuffer.prototype.put = function (num, length) {
    for (var i = 0; i < length; i += 1) {
      this.putBit(((num >>> (length - 1 - i)) & 1) === 1);
    }
  };

  BitBuffer.prototype.putBit = function (bit) {
    var bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) this.buffer.push(0);
    if (bit) this.buffer[bufIndex] |= 0x80 >>> this.length % 8;
    this.length += 1;
  };

  // --- 데이터 인코딩 -------------------------------------------------------------

  function toUtf8Bytes(text) {
    var encoded = encodeURIComponent(text);
    var bytes = [];
    for (var i = 0; i < encoded.length; i += 1) {
      if (encoded.charAt(i) === "%") {
        bytes.push(parseInt(encoded.substr(i + 1, 2), 16));
        i += 2;
      } else {
        bytes.push(encoded.charCodeAt(i));
      }
    }
    return bytes;
  }

  function chooseVersion(byteLength) {
    for (var v = 1; v <= 10; v += 1) {
      if (byteLength <= BYTE_CAPACITY_M[v - 1]) return v;
    }
    throw new Error("QR 데이터가 너무 깁니다 (최대 " + BYTE_CAPACITY_M[9] + "바이트)");
  }

  function createData(version, dataBytes) {
    var rsBlocks = getRsBlocks(version);
    var buffer = new BitBuffer();
    buffer.put(4, 4); // 바이트 모드
    buffer.put(dataBytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < dataBytes.length; i += 1) buffer.put(dataBytes[i], 8);

    var totalDataBits = 0;
    for (var r = 0; r < rsBlocks.length; r += 1) totalDataBits += rsBlocks[r].dataCount * 8;
    if (buffer.length > totalDataBits) {
      throw new Error("QR 버퍼 초과 (" + buffer.length + " > " + totalDataBits + ")");
    }
    if (buffer.length + 4 <= totalDataBits) buffer.put(0, 4);
    while (buffer.length % 8 !== 0) buffer.putBit(false);
    while (buffer.length < totalDataBits) {
      buffer.put(PAD0, 8);
      if (buffer.length >= totalDataBits) break;
      buffer.put(PAD1, 8);
    }
    return createBytes(buffer, rsBlocks);
  }

  function createBytes(buffer, rsBlocks) {
    var offset = 0;
    var maxDcCount = 0;
    var maxEcCount = 0;
    var dcdata = new Array(rsBlocks.length);
    var ecdata = new Array(rsBlocks.length);

    for (var r = 0; r < rsBlocks.length; r += 1) {
      var dcCount = rsBlocks[r].dataCount;
      var ecCount = rsBlocks[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);

      dcdata[r] = new Array(dcCount);
      for (var i = 0; i < dcCount; i += 1) {
        dcdata[r][i] = 0xff & buffer.buffer[i + offset];
      }
      offset += dcCount;

      var rsPoly = getErrorCorrectPolynomial(ecCount);
      var rawPoly = new Polynomial(dcdata[r], rsPoly.getLength() - 1);
      var modPoly = rawPoly.mod(rsPoly);
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (var j = 0; j < ecdata[r].length; j += 1) {
        var modIndex = j + modPoly.getLength() - ecdata[r].length;
        ecdata[r][j] = modIndex >= 0 ? modPoly.get(modIndex) : 0;
      }
    }

    var totalCodeCount = 0;
    for (var t = 0; t < rsBlocks.length; t += 1) totalCodeCount += rsBlocks[t].totalCount;

    var data = new Array(totalCodeCount);
    var index = 0;
    for (var d = 0; d < maxDcCount; d += 1) {
      for (var r2 = 0; r2 < rsBlocks.length; r2 += 1) {
        if (d < dcdata[r2].length) data[index++] = dcdata[r2][d];
      }
    }
    for (var e = 0; e < maxEcCount; e += 1) {
      for (var r3 = 0; r3 < rsBlocks.length; r3 += 1) {
        if (e < ecdata[r3].length) data[index++] = ecdata[r3][e];
      }
    }
    return data;
  }

  // --- 마스크 · 페널티 -----------------------------------------------------------

  function maskFunc(pattern, i, j) {
    switch (pattern) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
      case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
      default: throw new Error("mask:" + pattern);
    }
  }

  function lostPoint(modules) {
    var count = modules.length;
    var lost = 0;
    var row;
    var col;

    // 규칙 1: 인접 동일 색
    for (row = 0; row < count; row += 1) {
      for (col = 0; col < count; col += 1) {
        var sameCount = 0;
        var dark = modules[row][col];
        for (var r = -1; r <= 1; r += 1) {
          if (row + r < 0 || count <= row + r) continue;
          for (var c = -1; c <= 1; c += 1) {
            if (col + c < 0 || count <= col + c) continue;
            if (r === 0 && c === 0) continue;
            if (dark === modules[row + r][col + c]) sameCount += 1;
          }
        }
        if (sameCount > 5) lost += 3 + sameCount - 5;
      }
    }

    // 규칙 2: 2x2 블록
    for (row = 0; row < count - 1; row += 1) {
      for (col = 0; col < count - 1; col += 1) {
        var quad = 0;
        if (modules[row][col]) quad += 1;
        if (modules[row + 1][col]) quad += 1;
        if (modules[row][col + 1]) quad += 1;
        if (modules[row + 1][col + 1]) quad += 1;
        if (quad === 0 || quad === 4) lost += 3;
      }
    }

    // 규칙 3: 1:1:3:1:1 패턴
    for (row = 0; row < count; row += 1) {
      for (col = 0; col < count - 6; col += 1) {
        if (
          modules[row][col] && !modules[row][col + 1] && modules[row][col + 2] &&
          modules[row][col + 3] && modules[row][col + 4] && !modules[row][col + 5] &&
          modules[row][col + 6]
        ) {
          lost += 40;
        }
      }
    }
    for (col = 0; col < count; col += 1) {
      for (row = 0; row < count - 6; row += 1) {
        if (
          modules[row][col] && !modules[row + 1][col] && modules[row + 2][col] &&
          modules[row + 3][col] && modules[row + 4][col] && !modules[row + 5][col] &&
          modules[row + 6][col]
        ) {
          lost += 40;
        }
      }
    }

    // 규칙 4: 어두운 모듈 비율
    var darkCount = 0;
    for (col = 0; col < count; col += 1) {
      for (row = 0; row < count; row += 1) {
        if (modules[row][col]) darkCount += 1;
      }
    }
    lost += (Math.abs((100 * darkCount) / count / count - 50) / 5) * 10;
    return lost;
  }

  // --- 매트릭스 조립 --------------------------------------------------------------

  function setupPositionProbePattern(modules, count, row, col) {
    for (var r = -1; r <= 7; r += 1) {
      if (row + r <= -1 || count <= row + r) continue;
      for (var c = -1; c <= 7; c += 1) {
        if (col + c <= -1 || count <= col + c) continue;
        modules[row + r][col + c] =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  }

  function setupPositionAdjustPattern(modules, version) {
    var pos = PATTERN_POSITION[version - 1];
    for (var i = 0; i < pos.length; i += 1) {
      for (var j = 0; j < pos.length; j += 1) {
        var row = pos[i];
        var col = pos[j];
        if (modules[row][col] !== null) continue;
        for (var r = -2; r <= 2; r += 1) {
          for (var c = -2; c <= 2; c += 1) {
            modules[row + r][col + c] =
              r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          }
        }
      }
    }
  }

  function setupTimingPattern(modules, count) {
    for (var r = 8; r < count - 8; r += 1) {
      if (modules[r][6] !== null) continue;
      modules[r][6] = r % 2 === 0;
    }
    for (var c = 8; c < count - 8; c += 1) {
      if (modules[6][c] !== null) continue;
      modules[6][c] = c % 2 === 0;
    }
  }

  function setupTypeInfo(modules, count, maskPattern) {
    // 오류정정 레벨 M = 0b00
    var bits = getBCHTypeInfo(maskPattern & 7);
    var i;
    var mod;

    for (i = 0; i < 15; i += 1) {
      mod = ((bits >> i) & 1) === 1;
      if (i < 6) modules[i][8] = mod;
      else if (i < 8) modules[i + 1][8] = mod;
      else modules[count - 15 + i][8] = mod;
    }
    for (i = 0; i < 15; i += 1) {
      mod = ((bits >> i) & 1) === 1;
      if (i < 8) modules[8][count - i - 1] = mod;
      else if (i < 9) modules[8][15 - i - 1 + 1] = mod;
      else modules[8][15 - i - 1] = mod;
    }
    modules[count - 8][8] = true;
  }

  function setupTypeNumber(modules, count, version) {
    var bits = getBCHTypeNumber(version);
    for (var i = 0; i < 18; i += 1) {
      var mod = ((bits >> i) & 1) === 1;
      modules[Math.floor(i / 3)][(i % 3) + count - 8 - 3] = mod;
      modules[(i % 3) + count - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }

  function mapData(modules, count, data, maskPattern) {
    var inc = -1;
    var row = count - 1;
    var bitIndex = 7;
    var byteIndex = 0;

    for (var col = count - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      for (;;) {
        for (var c = 0; c < 2; c += 1) {
          if (modules[row][col - c] === null) {
            var dark = false;
            if (byteIndex < data.length) {
              dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
            }
            if (maskFunc(maskPattern, row, col - c)) dark = !dark;
            modules[row][col - c] = dark;
            bitIndex -= 1;
            if (bitIndex === -1) {
              byteIndex += 1;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || count <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }

  function makeMatrix(version, data, maskPattern) {
    var count = version * 4 + 17;
    var modules = new Array(count);
    for (var i = 0; i < count; i += 1) {
      modules[i] = new Array(count);
      for (var j = 0; j < count; j += 1) modules[i][j] = null;
    }
    setupPositionProbePattern(modules, count, 0, 0);
    setupPositionProbePattern(modules, count, count - 7, 0);
    setupPositionProbePattern(modules, count, 0, count - 7);
    setupPositionAdjustPattern(modules, version);
    setupTimingPattern(modules, count);
    setupTypeInfo(modules, count, maskPattern);
    if (version >= 7) setupTypeNumber(modules, count, version);
    mapData(modules, count, data, maskPattern);
    return modules;
  }

  // --- 공개 API ------------------------------------------------------------------

  function create(text) {
    var bytes = toUtf8Bytes(String(text));
    var version = chooseVersion(bytes.length);
    var data = createData(version, bytes);

    var bestModules = null;
    var bestMask = 0;
    var minLost = Infinity;
    for (var mask = 0; mask < 8; mask += 1) {
      var candidate = makeMatrix(version, data, mask);
      var lost = lostPoint(candidate);
      if (lost < minLost) {
        minLost = lost;
        bestModules = candidate;
        bestMask = mask;
      }
    }

    return {
      version: version,
      mask: bestMask,
      moduleCount: bestModules.length,
      modules: bestModules,
      isDark: function (row, col) {
        return bestModules[row][col] === true;
      }
    };
  }

  function toCanvas(canvas, text) {
    var qr = create(text);
    var count = qr.moduleCount;
    var size = canvas.width > 0 ? canvas.width : 220;
    canvas.width = size;
    canvas.height = size;

    var ctx = canvas.getContext("2d");
    var quiet = 2; // 콰이엇 존(모듈 단위)
    var cell = Math.floor(size / (count + quiet * 2));
    if (cell < 1) cell = 1;
    var offset = Math.floor((size - cell * count) / 2);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (var row = 0; row < count; row += 1) {
      for (var col = 0; col < count; col += 1) {
        if (qr.modules[row][col]) {
          ctx.fillRect(offset + col * cell, offset + row * cell, cell, cell);
        }
      }
    }
    return qr;
  }

  root.GyeideukQR = { toCanvas: toCanvas, create: create };
})(typeof window !== "undefined" ? window : globalThis);
