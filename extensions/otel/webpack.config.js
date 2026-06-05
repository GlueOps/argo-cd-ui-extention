const webpack = require('webpack');
const path = require('path');
const packageJson = require('./package.json');

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'extensions.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'argocdOtelExtension',
    libraryTarget: 'window',
    clean: true
  },
  externals: {
    react: 'React'
  },
  mode: 'production',
  plugins: [
    new webpack.DefinePlugin({
      '__EXTENSION_VERSION__': JSON.stringify(packageJson.version)
    })
  ]
};
