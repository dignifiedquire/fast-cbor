'use strict'

const stream = require('stream')
const url = require('url')
const bignumber = require('bignumber.js')
const NoFilter = require('nofilter')
const Tagged = require('./tagged')
const Simple = require('./simple')

const constants = require('./constants')
const MT = constants.MT, NUMBYTES = constants.NUMBYTES, SHIFT32 = constants.SHIFT32, SYMS = constants.SYMS, TAG = constants.TAG
const DOUBLE = (constants.MT.SIMPLE_FLOAT << 5) | constants.NUMBYTES.EIGHT
const TRUE = (constants.MT.SIMPLE_FLOAT << 5) | constants.SIMPLE.TRUE
const FALSE = (constants.MT.SIMPLE_FLOAT << 5) | constants.SIMPLE.FALSE
const UNDEFINED = (constants.MT.SIMPLE_FLOAT << 5) | constants.SIMPLE.UNDEFINED
const NULL = (constants.MT.SIMPLE_FLOAT << 5) | constants.SIMPLE.NULL

const MAXINT_BN = new bignumber('0x20000000000000')
const BUF_NAN = new Buffer('f97e00', 'hex')
const BUF_INF_NEG = new Buffer('f9fc00', 'hex')
const BUF_INF_POS = new Buffer('f97c00', 'hex')

const NO_ASSERT = true

function toType (obj) {
  // [object Type]
  // --------8---1
  return ({}).toString.call(obj).slice(8, -1)
}

/**
 * Transform JavaScript values into CBOR bytes
 *
 */
class Encoder {
  constructor (options) {
    options = options || {}

    this.semanticTypes = [
      [url.Url, this._pushUrl],
      [bignumber, this._pushBigNumber]
    ]

    const addTypes = options.genTypes || []
    const len = addTypes.length
    for (let i = 0; i < len; i ++) {
      this.addSemanticType(
        addTypes[i][0],
        addTypes[i][1]
      )
    }

    this.result = []
    this.resultMethod = []
    this.resultLength = []
    this.offset = 0
  }

  addSemanticType (type, fun) {
    const len = this.semanticTypes.length
    for (let i = 0; i < len; i ++) {
      const typ = this.semanticTypes[i][0]
      if (typ === type) {
        const old = this.semanticTypes[i][1]
        this.semanticTypes[i][1] = fun
        return old
      }
    }
    this.semanticTypes.push([type, fun])
    return null
  }

  push (val) {
    if (!val) {
      return true
    }

    this.result[this.offset] = val
    this.resultMethod[this.offset] = 0
    this.resultLength[this.offset] = val.length
    this.offset ++
    return true
  }

  pushWrite (val, method, len) {
    this.result[this.offset] = val
    this.resultMethod[this.offset] = method
    this.resultLength[this.offset] = len
    this.offset ++
    return true
  }

  _pushUInt8 (val) {
    return this.pushWrite(val, 1, 1)
  }

  _pushUInt16BE (val) {
    return this.pushWrite(val, 2, 2)
  }

  _pushUInt32BE (val) {
    return this.pushWrite(val, 3, 4)
  }

  _pushDoubleBE (val) {
    return this.pushWrite(val, 4, 8)
  }

  _pushNaN () {
    return this.push(BUF_NAN)
  }

  _pushInfinity (obj) {
    const half = (obj < 0) ? BUF_INF_NEG : BUF_INF_POS
    return this.push(half)
  }

  _pushFloat (obj) {
    this._pushUInt8(DOUBLE)
    return this._pushDoubleBE(obj)
  }

  _pushInt (obj, mt, orig) {
    const m = mt << 5
    switch (false) {
      case !(obj < 24):
        return this._pushUInt8(m | obj)
      case !(obj <= 0xff):
        return this._pushUInt8(m | NUMBYTES.ONE) && this._pushUInt8(obj)
      case !(obj <= 0xffff):
        return this._pushUInt8(m | NUMBYTES.TWO) && this._pushUInt16BE(obj)
      case !(obj <= 0xffffffff):
        return this._pushUInt8(m | NUMBYTES.FOUR) && this._pushUInt32BE(obj)
      case !(obj <= Number.MAX_SAFE_INTEGER):
        return this._pushUInt8(m | NUMBYTES.EIGHT) &&
          this._pushUInt32BE(Math.floor(obj / SHIFT32)) &&
          this._pushUInt32BE(obj % SHIFT32)
      default:
        if (mt === MT.NEG_INT) {
          return this._pushFloat(orig)
        } else {
          return this._pushFloat(obj)
        }
    }
  }

  _pushIntNum (obj) {
    if (obj < 0) {
      return this._pushInt(-obj - 1, MT.NEG_INT, obj)
    } else {
      return this._pushInt(obj, MT.POS_INT)
    }
  }

  _pushNumber (obj) {
    switch (false) {
      case (obj === obj):
        return this._pushNaN(obj)
      case isFinite(obj):
        return this._pushInfinity(obj)
      case ((obj % 1) !== 0):
        return this._pushIntNum(obj)
      default:
        return this._pushFloat(obj)
    }
  }

  _pushString (obj) {
    const len = Buffer.byteLength(obj, 'utf8')
    return this._pushInt(len, MT.UTF8_STRING) && this.pushWrite(obj, 5, len)
  }

  _pushBoolean (obj) {
    return this._pushUInt8(obj ? TRUE : FALSE)
  }

  _pushUndefined (obj) {
    return this._pushUInt8(UNDEFINED)
  }

  _pushArray (gen, obj) {
    const len = obj.length
    if (!gen._pushInt(len, MT.ARRAY)) {
      return false
    }
    for (let j = 0; j < len; j++) {
      if (!gen.pushAny(obj[j])) {
        return false
      }
    }
    return true
  }

  _pushTag (tag) {
    return this._pushInt(tag, MT.TAG)
  }

  _pushDate (gen, obj) {
    return gen._pushTag(TAG.DATE_EPOCH) && gen.pushAny(obj / 1000)
  }

  _pushBuffer (gen, obj) {
    return gen._pushInt(obj.length, MT.BYTE_STRING) && gen.push(obj)
  }

  _pushNoFilter (gen, obj) {
    return gen._pushBuffer(gen, obj.slice())
  }

  _pushRegexp (gen, obj) {
    return gen._pushTag(TAG.REGEXP) && gen.pushAny(obj.source)
  }

  _pushSet (gen, obj) {
    if (!gen._pushInt(obj.size, MT.ARRAY)) {
      return false
    }
    for (let x of obj) {
      if (!gen.pushAny(x)) {
        return false
      }
    }
    return true
  }

  _pushUrl (gen, obj) {
    return gen._pushTag(TAG.URI) && gen.pushAny(obj.format())
  }

  _pushBigint (obj) {
    let tag = TAG.POS_BIGINT
    if (obj.isNegative()) {
      obj = obj.negated().minus(1)
      tag = TAG.NEG_BIGINT
    }
    let str = obj.toString(16)
    if (str.length % 2) {
      str = '0' + str
    }
    const buf = new Buffer(str, 'hex')
    return this._pushTag(tag) && this._pushBuffer(this, buf)
  }

  _pushBigNumber (gen, obj) {
    if (obj.isNaN()) {
      return gen._pushNaN()
    }
    if (!obj.isFinite()) {
      return gen._pushInfinity(obj.isNegative() ? -Infinity : Infinity)
    }
    if (obj.isInteger()) {
      return gen._pushBigint(obj)
    }
    if (!(gen._pushTag(TAG.DECIMAL_FRAC) &&
      gen._pushInt(2, MT.ARRAY))) {
      return false
    }

    const dec = obj.decimalPlaces()
    const slide = obj.mul(new bignumber(10).pow(dec))
    if (!gen._pushIntNum(-dec)) {
      return false
    }
    if (slide.abs().lessThan(MAXINT_BN)) {
      return gen._pushIntNum(slide.toNumber())
    } else {
      return gen._pushBigint(slide)
    }
  }

  _pushMap (gen, obj) {
    if (!gen._pushInt(obj.size, MT.MAP)) {
      return false
    }
    for (let kv of obj) {
      if (!(gen.pushAny(kv[0]) && gen.pushAny(kv[1]))) {
        return false
      }
    }
    return true
  }

  _pushObject (obj) {
    if (!obj) {
      return this._pushUInt8(NULL)
    }

    var len = this.semanticTypes.length
    for (var i = 0; i < len; i ++) {
      if (obj instanceof this.semanticTypes[i][0]) {
        return this.semanticTypes[i][1].call(obj, this, obj)
      }
    }

    var f = obj.encodeCBOR
    if (typeof f === 'function') {
      return f.call(obj, this)
    }

    var keys = Object.keys(obj)
    var keyLength = keys.length
    if (!this._pushInt(keyLength, MT.MAP)) {
      return false
    }

    for (var j = 0; j < keyLength; j++) {
      var k = keys[j]
      if (!(this._pushString(k) && this.pushAny(obj[k]))) {
        return false
      }
    }
    return true
  }

  /**
   * Push any supported type onto the encoded stream
   *
   * @param {any} obj
   * @returns {boolean} true on success
   */
  pushAny (obj) {
    var typ = toType(obj)

    switch (typ) {
      case 'Number':
        return this._pushNumber(obj)
      case 'String':
        return this._pushString(obj)
      case 'Boolean':
        return this._pushBoolean(obj)
      case 'Object':
        return this._pushObject(obj)
      case 'Array':
        return this._pushArray(this, obj)
      case 'Uint8Array':
        return this._pushBuffer(this, obj)
      case 'Null':
        return this._pushUInt8(NULL)
      case 'Undefined':
        return this._pushUndefined(obj)
      case 'Map':
        return this._pushMap(this, obj)
      case 'Set':
        return this._pushSet(this, obj)
      case 'Date':
        return this._pushDate(this, obj)
      case 'RegExp':
        return this._pushRegexp(this, obj)
      case 'Symbol':
        switch (obj) {
          case SYMS.NULL:
            return this._pushObject(null)
          case SYMS.UNDEFINED:
            return this._pushUndefined(void 0)
          // TODO: Add pluggable support for other symbols
          default:
            throw new Error('Unknown symbol: ' + obj.toString())
        }
      default:
        throw new Error('Unknown type: ' + typeof obj + ', ' + (!!obj ? obj.toString() : ''))
    }
  }

  _calculateSize (offset, resultLength) {
    // Determine the size of the buffer
    var size = 0
    var i
    for (i = 0; i < offset; i ++) {
      size += resultLength[i]
    }

    return size
  }

  finalize () {
    if (this.offset === 0) {
      return null
    }

    var result = this.result
    var resultLength = this.resultLength
    var resultMethod = this.resultMethod
    var offset = this.offset
    var res = Buffer.allocUnsafe(this._calculateSize(offset, resultLength))
    var index = 0
    var method
    var length
    var enc
    var val
    var i
    var typ

    // Write the content into the result buffer
    for (i = 0; i < offset; i ++) {
      length = resultLength[i]

      switch (resultMethod[i]) {
        case 0:
          result[i].copy(res, index)
          break
        case 1:
          res.writeUInt8(result[i], index, NO_ASSERT)
          break
        case 2:
          res.writeUInt16BE(result[i], index, NO_ASSERT)
          break
        case 3:
          res.writeUInt32BE(result[i], index, NO_ASSERT)
          break
        case 4:
          res.writeDoubleBE(result[i], index, NO_ASSERT)
          break
        case 5:
          res.write(result[i], index, length, 'utf8')
          break
      }

      index += length
    }

    return res
  }

  static encode (o) {
    const enc = new Encoder()
    enc.pushAny(o)

    return enc.finalize()
  }
}

module.exports = Encoder