const sass = require('sass');
const pug = require('pug');
const fs = require('fs');
const path = require('path');
const {globSync} = require('glob');
const crypto = require('crypto');
const chokidar = require('chokidar');
const {minimatch} = require('minimatch');

class Bundler {
	/** @type {Loader[]} */
	#loaders = [];

	/**
	 * @param  {...Loader} loaders 
	 * @returns this
	 */
	add(...loaders) {
		this.#loaders.push(...loaders);
		return this;
	}

	/** Build the bundles */
	build() {
		try {
			for(const loader of this.#loaders) loader.load();
		}
		catch(error) {
			console.error(error);
		}
	}

	/**
	 * Watch the files matching the given glob patterns and rebuild the affected bundles.
	 * @param {string|string[]} watchGlob 
	 * @param {string|string[]|null} ignoreGlob 
	 */
	watch(watchGlob, ignoreGlob) {
		const watcher = chokidar.watch(watchGlob, {persistent: true, ignoreInitial: true, ignored: ignoreGlob});
		const rebuild = filepath => {
			console.log(`Change in: ${filepath}\nRebuilding...`);
			for(const loader of this.#loaders) loader.load(new FileChange(filepath));
			console.log('Build done.')
		};
		watcher.on('add', rebuild).on('change', rebuild).on('unlink', rebuild).on('error', error => {
			console.error(error);
		}).on('ready', () => {
			for(const loader of this.#loaders) loader.load();
			console.log('Initial scan complete. Ready for changes.')
		});
	}
}

class FileChange {
	/** @type {string} */
	filepath;

	/** @type {string} */
	sha256 = null;

	/** @param {string} filepath  */
	constructor(filepath, sha256=null) {
		this.filepath = filepath;
		this.sha256 = sha256 || getHash(fs.readFileSync(filepath));
	}
}

class FileCache {
	/** @type {FileChange[]} */
	inputFilesHashes = [];

	/** @type {string[]} */
	result = [];

	clear() {
		this.inputFilesHashes = [];
		this.result = [];
	}
	/**
	 * @param {FileChange} fileChange 
	 * @returns {boolean}
	 */
	haveNotChanged(fileChange) {
		return !!this.inputFilesHashes.filter(ifh => ifh.filepath === fileChange.filepath && ifh.sha256 === fileChange.sha256).shift();
	}
}

class Loader {
	cache = new FileCache();

	/**
	 * @param {boolean} checkDiff 
	 * @returns {string|string[]}
	 */
	load(fileChanged=null) {}

	/** @returns {string|string[]} */
	get inputPath() {}
}

class FontLoader extends Loader {
	/** @type {string} */
	#inputGlob;

	/** @type {string} */
	#outputPath = null;

	/** @param {string} inputGlob */
	constructor(inputGlob) {
		super();
		this.#inputGlob = inputGlob;
	}

	/** @param {string} outputPath */
	outputScss(outputPath) {
		this.#outputPath = outputPath;
		return this;
	}

	get inputPath() {
		return this.#inputGlob;
	}

	load(fileChanged=null) {
		if(fileChanged && (!minimatch(fileChanged.filepath, this.#inputGlob) || this.cache.haveNotChanged(fileChanged))) {
			console.log('Using cached fonts.');
			return this.cache.result[0];
		}
		this.cache.clear();
		const files = globSync(this.#inputGlob).sort();
		if(files.length === 0) return;
		const fonts = {};
		for(const f of files) {
			const name = path.parse(f).name.replace(' ', '_');
			const ext = path.extname(f).replace('.', '').toLocaleLowerCase();
			if(!MIMETYPES[ext]) continue;
			const content = fs.readFileSync(f);
			const b64 = Buffer.from(content).toString('base64');
			const dataURL = `data:${MIMETYPES[ext]};base64,${b64}`;
			if(!fonts[name]) fonts[name] = {woff2: null, woff: null, ttf: null};
			if(ext in fonts[name]) {
				fonts[name][ext] = dataURL;
				this.cache.inputFilesHashes.push(new FileChange(f, getHash(content)));
			}
		}
		const mixins = [];
		for(let fontname in fonts) {
			let fontMixin = '@mixin ';
			fontMixin += fontname;
			fontMixin += ' {\n\tfont-family: \'';
			fontMixin += fontname;
			fontMixin += '\';\n\tsrc: ';
			const font = fonts[fontname];
			const urls = [];
			if(font.woff2) urls.push(`url(${font.woff2}) format('woff2')`);
			else if(font.woff) urls.push(`url(${font.woff}) format('woff')`);
			else if(font.ttf) urls.push(`url(${font.ttf}) format('truetype')`);
			if(urls.length === 0) continue;
			fontMixin += urls.join(',\n\t\t')+';\n}\n';
			mixins.push(fontMixin);
		}
		const result = mixins.join('\n');
		if(result) writeFile(this.#outputPath, result);
		this.cache.result = [result];
		return result;
	}
}
class ImgLoader extends Loader {
	/** @type {string} */
	#inputGlob;

	/** @type {string} */
	#outputTs = null;

	/** @type {string} */
	#outputScss = null;

	/** @param {string} inputGlob */
	constructor(inputGlob) {
		super();
		this.#inputGlob = inputGlob;
	}

	/** @param {string} outputPath */
	outputTs(outputPath) {
		this.#outputTs = outputPath;
		return this;
	}

	/** @param {string} outputPath */
	outputScss(outputPath) {
		this.#outputScss = outputPath;
		return this;
	}

	get inputPath() {
		return this.#inputGlob;
	}

	load(fileChanged=null) {
		if(fileChanged && (!minimatch(fileChanged.filepath, this.#inputGlob) || this.cache.haveNotChanged(fileChanged))) {
			console.log('Using cached images.');
			return this.cache.result;
		}
		this.cache.clear();
		const files = globSync(this.#inputGlob).sort();
		if(files.length === 0) return;
		const common = findCommonPath(files);
		const images = files.map(f => {
			const assetName = generateAssetName(f, common);
			const ext = path.extname(f).replace('.', '').toLocaleLowerCase();
			if(!MIMETYPES[ext]) return null;
			const content = fs.readFileSync(f);
			const b64 = Buffer.from(content).toString('base64');
			const dataURL = `data:${MIMETYPES[ext]};base64,${b64}`;
			this.cache.inputFilesHashes.push(new FileChange(f, getHash(content)));
			return {name: assetName, url: dataURL};
		}).filter(f => f);
		const imagesTs = images.map(img => `export const ${img.name} = '${img.url}';`).join('\n');
		const imagesScss = images.map(img => `$${img.name}: '${img.url}';`).join('\n');
		const imageJS = {}; images.forEach(img => imageJS[img.name] = img.url);
		if(imagesTs) writeFile(this.#outputTs, imagesTs);
		if(imagesScss) writeFile(this.#outputScss, imagesScss);
		return this.cache.result = {ts:imagesTs, scss:imagesScss, js:imageJS};
	}
}

class ScssLoader extends Loader {
	/** @type {string} */
	#inputPath;

	/** @type {string} */
	#outputPath = null;

	/** @param {string} inputPath */
	constructor(inputPath) {
		super();
		this.#inputPath = inputPath;
	}

	/** @param {string} outputPath */
	outputCss(outputPath) {
		this.#outputPath = outputPath;
		return this;
	}

	get inputPath() {
		return this.#inputPath;
	}

	load(fileChanged=null) {
		if(fileChanged && !minimatch(fileChanged.filepath, '**/*.{scss,sass,woff2,woff,ttf}')) {
			console.log('Using cached styles.');
			return this.cache.result;
		}
		const result = sass.compile(this.#inputPath, {style: "compressed"}).css.toString();
		writeFile(this.#outputPath, result);
		return this.cache.result = result;
	}
}

class PugLoader extends Loader {
	/** @type {string} */
	#inputPath;

	/** @type {string} */
	#outputPath = null;

	#pugData = {};

	/** @param {string} inputPath */
	constructor(inputPath) {
		super();
		this.#inputPath = inputPath;
	}

	/** @param {string} outputPath */
	outputHtml(outputPath) {
		this.#outputPath = outputPath;
		return this;
	}

	/**
	 * @param {string} key 
	 * @param {any|Loader} value 
	 */
	data(key, value) {
		this.#pugData[key] = value;
		return this;
	}

	get inputPath() {
		const result = [this.#inputPath];
		for(let key in this.#pugData) {
			const d = this.#pugData[key];
			if(d instanceof Loader) {
				const p = d.inputPath;
				if(Array.isArray(p)) result.push(...p);
				else result.push(p);
			}
		}
		return result;
	}

	load(fileChanged=null) {
		const pugData = {};
		for(let key in this.#pugData) {
			const value = this.#pugData[key];
			pugData[key] = value instanceof Loader ? value.load(fileChanged) : value;
		}
		const template = pug.compileFile(this.#inputPath);
		const result = template(pugData);
		writeFile(this.#outputPath, result);
		return result;
	}
}

const MIMETYPES = {
	'ttf': 'font/sfnt',
	'woff': 'application/octet-stream',
	'woff2': 'application/octet-stream',

	'avif': 'image/avif',
	'gif': 'image/gif',
	'jpeg': 'image/jpeg',
	'jpg': 'image/jpg',
	'png': 'image/png',
	'webp': 'image/webp',
	'svg': 'image/svg+xml',
};

/**
 * Find the common path between the given paths.
 * @param {string[]} paths 
 * @returns {string}
 */
function findCommonPath(paths) {
	if(paths.length === 0) return '';
	if(paths.length === 1) return path.dirname(paths[0]);
	const pathsSegments = paths.map(p => p.split(path.sep));
	const firstPath = pathsSegments[0];
	for(let i = 0; i < firstPath.length; i++) {
		for(let j = 1; j < pathsSegments.length; j++) {
			if(firstPath[i] !== pathsSegments[j][i]) return firstPath.slice(0, i).join(path.sep);
		}
	}
	return path.dirname(paths[0]);
}

/**
 * Create a normalized asset name from filePath and remove the given prefix.
 * @param {string} filePath
 * @param {string} prefixToRemove
 * @returns {string}
 */
function generateAssetName(filePath, prefixToRemove='') {
	return filePath.replace(prefixToRemove, '').replace(/^(\/|\\)/, '').replace(/(\/|\\| |\.|\-|\(|\))/g, '_');
}

/**
 * Write content to filepath.
 * If checkDiff is enabled, the file is written only if the content in parameter and the content at filepath is different.
 * @param {string} filepath
 * @param {Buffer} content
 * @param {boolean} checkDiff
 */
function writeFile(filepath, content, checkDiff=false) {
	if(filepath) {
		if(checkDiff && fs.existsSync(filepath)) {
			const fileHash = getHash(fs.readFileSync(filepath));
			const contentHash = getHash(content);
			if(fileHash === contentHash) return;
		}
		else fs.mkdirSync(path.dirname(filepath), {recursive: true});
		fs.writeFileSync(filepath, content);
	}
}

/**
 * Generate sha256 hash of content
 * @param {Buffer} content
 */
function getHash(content) {
	return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = {Bundler, FontLoader, ImgLoader, PugLoader, ScssLoader};
