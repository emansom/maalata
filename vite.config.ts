import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import fs from 'node:fs';
import dts from 'vite-plugin-dts';
import { buildHash, sharedEsbuildOptions, sharedTreeshake, sharedCompactOutput, sharedCompressionPlugins } from './vite.config.shared';

function updatePackageExports(): Plugin {
  return {
    name: 'update-package-exports',
    closeBundle() {
      const pkgPath = resolve(__dirname, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      pkg.main = `dist/maalata.${buildHash}.umd.js`;
      pkg.module = `dist/maalata.${buildHash}.es.js`;
      pkg.exports['.'].import = `./dist/maalata.${buildHash}.es.js`;
      pkg.exports['.'].require = `./dist/maalata.${buildHash}.umd.js`;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    },
  };
}

export default defineConfig(({ mode }) => {
  const dev = mode === 'development';

  return {
    plugins: [
      dts({
        rollupTypes: true,
      }),
      ...sharedCompressionPlugins(dev),
      updatePackageExports(),
    ],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        name: 'Maalata',
        formats: ['es', 'umd'],
        fileName: (format) => `maalata.${buildHash}.${format}.js`
      },
      rollupOptions: {
        // Don't bundle canvas-ultrafast — it's a peer/dependency
        external: ['canvas-ultrafast'],
        treeshake: sharedTreeshake,
        output: {
          ...sharedCompactOutput,
          globals: {
            'canvas-ultrafast': 'CanvasUltrafast',
          },
        },
      },
      sourcemap: dev,
      minify: dev ? false : 'esbuild',
      outDir: 'dist',
      emptyOutDir: true,
    },
    esbuild: {
      ...sharedEsbuildOptions(dev),
      mangleProps: !dev ? /^_/ : undefined,
      mangleQuoted: !dev,
    },
  };
});
