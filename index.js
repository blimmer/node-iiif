const probe = require('probe-image-size');
const mime = require('mime-types');
const transform = require('./lib/transform');
const IIIFError = require('./lib/error');

const filenameRe = /(color|gray|bitonal|default)\.(jpe?g|tiff?|gif|png|webp)/;

function parseUrl (url) {
  const result = {};
  const segments = url.split('/');
  result.filename = segments.pop();
  if (result.filename.match(filenameRe)) {
    result.rotation = segments.pop();
    result.size = segments.pop();
    result.region = segments.pop();
    result.quality = RegExp.$1;
    result.format = RegExp.$2;
  }
  result.id = decodeURIComponent(segments.pop());
  result.baseUrl = segments.join('/');
  return result;
}

class Processor {
  constructor (url, streamResolver, dimensionFunction, maxWidth, includeMetadata) {
    this.initialize(url);

    if (!filenameRe.test(this.filename) && this.filename !== 'info.json') {
      throw new this.errorClass(`Invalid IIIF URL: ${url}`); // eslint-disable-line new-cap
    }

    this.streamResolver = streamResolver;
    this.dimensionFunction = dimensionFunction || this.defaultDimensionFunction;
    this.maxWidth = maxWidth;
    this.includeMetadata = !!includeMetadata;
  }

  initialize (url) {
    let params = url;
    if (typeof url === 'string') {
      params = parseUrl(params);
    }
    Object.assign(this, params);

    if (this.quality && this.format) {
      this.filename = [this.quality, this.format].join('.');
    }

    this.errorClass = IIIFError;
  }

  async withStream (id, callback) {
    if (this.streamResolver.length === 2) {
      return await this.streamResolver(id, callback);
    } else {
      const stream = await this.streamResolver(id);
      return await callback(stream);
    }
  }

  async defaultDimensionFunction (id) {
    return await this.withStream(id, async (stream) => {
      return await probe(stream);
    });
  }

  async dimensions () {
    const fallback = this.dimensionFunction !== this.defaultDimensionFunction;

    if (this.sizeInfo === null) {
      let dims = await this.dimensionFunction(this.id);
      if (fallback && (dims === null)) {
        console.warn(`Unable to get dimensions for ${this.id} using custom function. Falling back to probe().`);
        dims = await this.defaultDimensionFunction(this.id);
      }
      this.sizeInfo = dims;
    }
    return this.sizeInfo;
  }

  async infoJson () {
    const dim = await this.dimensions();
    const sizes = [];
    for (let size = [dim.width, dim.height]; size.every((x) => x >= 64); size = size.map((x) => Math.floor(x / 2))) {
      sizes.push({ width: size[0], height: size[1] });
    }

    const doc = this.infoDoc(dim, sizes);

    if (this.maxWidth) doc.profile[1].maxWidth = this.maxWidth;

    return { contentType: 'application/json', body: JSON.stringify(doc) };
  }

  infoDoc (dim, sizes) {
    return {
      '@context': 'http://iiif.io/api/image/2/context.json',
      '@id': [this.baseUrl, encodeURIComponent(this.id)].join('/'),
      protocol: 'http://iiif.io/api/image',
      width: dim.width,
      height: dim.height,
      sizes: sizes,
      tiles: [
        {
          width: 512,
          height: 512,
          scaleFactors: sizes.map((_v, i) => 2 ** i)
        }
      ],
      profile: [
        'http://iiif.io/api/image/2/level2.json',
        {
          formats: transform.Formats,
          qualities: transform.Qualities,
          supports: ['regionByPx', 'sizeByW', 'sizeByWhListed', 'cors', 'regionSquare', 'sizeByDistortedWh', 'sizeAboveFull', 'canonicalLinkHeader', 'sizeByConfinedWh', 'sizeByPct', 'jsonldMediaType', 'regionByPct', 'rotationArbitrary', 'sizeByH', 'baseUriRedirect', 'rotationBy90s', 'profileLinkHeader', 'sizeByForcedWh', 'sizeByWh', 'mirroring']
        }
      ]
    };
  }

  pipeline (dim) {
    return new transform.Operations(dim)
      .region(this.region)
      .size(this.size)
      .rotation(this.rotation)
      .quality(this.quality)
      .format(this.format)
      .withMetadata(this.includeMetadata).pipeline;
  }

  async iiifImage () {
    try {
      const dim = await this.dimensions();
      const pipeline = this.pipeline(dim);

      const result = await this.withStream(this.id, async (stream) => {
        return await stream.pipe(pipeline).toBuffer();
      });
      return { contentType: mime.lookup(this.format), body: result };
    } catch (err) {
      throw new IIIFError(`Unhandled transformation error: ${err.message}`);
    }
  }

  async execute () {
    try {
      if (this.filename === 'info.json') {
        return this.infoJson();
      } else {
        return this.iiifImage();
      }
    } catch (err) {
      console.log('Caught while executing', err.message);
    }
  }
}

module.exports = { Processor, IIIFError };
