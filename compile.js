const {Bundler, FontLoader, ImgLoader, PugLoader, ScssLoader} = require('./bundler.js');

const SRC = './src/';
const DIST = './dist/';

new Bundler().add(
	new FontLoader(SRC+'fonts/**/*.{ttf,woff,woff2}')
		.outputScss(SRC+'assets/fonts.scss'),
	new ImgLoader(SRC+'img/**/*.{png,jpg,jpeg,gif,webp,avif}')
		.outputScss(SRC+'assets/img.scss'),
	new PugLoader(SRC+'cv.pug')
		.outputHtml(DIST+'cv.html')
		.data('CSS', new ScssLoader(SRC+'cv.scss'))
).build();
