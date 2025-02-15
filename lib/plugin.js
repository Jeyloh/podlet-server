import { join } from 'node:path';
import fp from 'fastify-plugin';
import { existsSync } from 'node:fs';
import { html, unsafeStatic } from 'lit/static-html.js';
import resolve from './resolve.js';

// plugins
import assetsPn from '../plugins/assets.js';
import compressionPn from '../plugins/compression.js';
import errorsPn from '../plugins/errors.js';
import exceptionsPn from '../plugins/exceptions.js';
import hydratePn from '../plugins/hydrate.js';
import importElementPn from '../plugins/import-element.js';
import liveReloadPn from '../plugins/live-reload.js';
import localePn from '../plugins/locale.js';
import metricsPn from '../plugins/metrics.js';
import podletPn from '../plugins/podlet.js';
import scriptPn from '../plugins/script.js';
import timingPn from '../plugins/timing.js';
import validationPn from '../plugins/validation.js';
import lazyPn from '../plugins/lazy.js';
import scriptsPn from '../plugins/scripts.js';
import ssrPn from '../plugins/ssr.js';
import csrPn from '../plugins/csr.js';
import documentPn from '../plugins/document.js';
import docsPn from '../plugins/docs.js';
import bundlerPn from '../plugins/bundler.js';
import { isAbsoluteURL, joinURLPathSegments } from './utils.js';

const defaults = {
  headers: {},
  querystring: {},
  params: {},
};

/**
 * create an intersection type out of fastify instance and its decorated properties
 * @typedef {import("fastify").FastifyInstance & { podlet: any, metrics: any, schemas: any, importElement: function, readTranslations: function, script: function, hydrate: function, ssr: function, csr: function }} FastifyInstance
 */

/**
 * create an intersection type out of fastify context config and its decorated properties
 * @typedef {import("fastify").FastifyContextConfig & { timing: boolean }} FastifyContextConfig
 */

export default fp(
  /**
   *
   * @param {import("fastify").FastifyInstance} fastify
   * @param {{ prefix: string, extensions: import("./resolvers/extensions.js").Extensions, cwd: string, plugins: import("esbuild").Plugin[], config: import("convict").Config, webSocketServer?: import("ws").WebSocketServer, clientWatcher?: import("chokidar").FSWatcher }} options
   */
  async (
    fastify,
    {
      prefix = '/',
      extensions,
      cwd = process.cwd(),
      plugins = [],
      config,
      webSocketServer,
      clientWatcher,
    },
  ) => {
    // @ts-ignore
    const base = config.get('assets.base') || '/';
    const name = config.get('app.name');
    const port = config.get('app.port');
    const pathname = config.get('podlet.pathname') || '/';
    const manifest = config.get('podlet.manifest') || '/manifest.json';
    const content = config.get('podlet.content') || '/';
    const fallback = config.get('podlet.fallback') || '';
    const development = config.get('app.development') || false;
    const version = config.get('podlet.version') || null;
    const locale = config.get('app.locale') || '';
    const lazy = config.get('assets.lazy') || false;
    const scripts = config.get('assets.scripts') || false;
    const compression = config.get('app.compression');
    const grace = config.get('app.grace') || 0;
    const timeAllRoutes = config.get('metrics.timing.timeAllRoutes') || true;
    const groupStatusCodes =
      config.get('metrics.timing.groupStatusCodes') || true;
    const mode = config.get('app.mode') || 'hydrate';
    const webSocketServerPort = config.get('development.liveReload.port');

    const assetBase = isAbsoluteURL(base)
      ? base
      : joinURLPathSegments(prefix, base);
    const contentFilePath = await resolve(join(cwd, './content.js'));
    const fallbackFilePath = await resolve(join(cwd, './fallback.js'));

    let podlet;
    let metrics;
    let schemas;
    /** @type {stateFunction} */
    let contentStateFn = async () => ({});
    /** @type {stateFunction} */
    let fallbackStateFn = async () => ({});

    // wrap in scoped plugin for prefixed routes to work
    await fastify.register(
      async (fastifyInstance) => {
        // cast fastify to include decorated properties
        const f = /** @type {FastifyInstance} */ (fastifyInstance);

        // load plugins
        await f.register(podletPn, {
          name,
          version,
          pathname,
          manifest,
          content,
          fallback,
          development,
        });
        await f.register(lazyPn, { enabled: lazy, base, development, prefix });
        await f.register(scriptsPn, {
          enabled: scripts,
          base,
          development,
          prefix,
        });
        await f.register(liveReloadPn, {
          development,
          port,
          prefix,
          clientWatcher,
          webSocketServer,
          webSocketServerPort,
        });
        await f.register(compressionPn, { enabled: compression });
        await f.register(errorsPn);
        await f.register(assetsPn, { base, cwd });
        await f.register(bundlerPn, { cwd, development, plugins });
        await f.register(exceptionsPn, { grace, development });
        await f.register(hydratePn, {
          appName: name,
          base: assetBase,
          development,
          prefix,
        });
        await f.register(csrPn, {
          appName: name,
          base: assetBase,
          development,
          prefix,
        });
        await f.register(ssrPn, { appName: name, base, prefix, development });
        await f.register(importElementPn, {
          appName: name,
          development,
          plugins,
          cwd,
        });
        await f.register(localePn, { locale, cwd });
        await f.register(metricsPn);
        await f.register(scriptPn, { development });
        await f.register(timingPn, {
          timeAllRoutes,
          groupStatusCodes,
        });
        await f.register(validationPn, {
          prefix,
          defaults,
          mappings: { '/': 'content.json' },
          cwd,
        });
        await f.register(documentPn, {
          podlet: f.podlet,
          cwd,
          development,
          extensions,
        });
        await f.register(docsPn, { podlet: f.podlet, config, extensions });

        // routes
        if (existsSync(contentFilePath)) {
          const tag = unsafeStatic(`${name}-content`);
          f.get(f.podlet.content(), async (request, reply) => {
            try {
              const contextConfig = /** @type {FastifyContextConfig} */ (
                reply.context.config
              );
              contextConfig.timing = true;

              if (mode === 'ssr-only' || mode === 'hydrate') {
                // import server side component
                await f.importElement(contentFilePath);
              }

              const initialState = JSON.stringify(
                // @ts-ignore
                (await contentStateFn(request, reply.app.podium.context)) || '',
              );

              const messages = await f.readTranslations();

              const translations = messages ? JSON.stringify(messages) : '';

              // includes ${null} hack for SSR. See https://github.com/lit/lit/issues/2246
              const template = html`
                  <${tag} version="${version}" locale='${locale}' translations='${translations}'
                          initial-state='${initialState}'></${tag}>${null} `;
              const hydrateSupport =
                mode === 'hydrate'
                  ? f.script(
                      joinURLPathSegments(
                        prefix,
                        '/_/dynamic/modules/@lit-labs/ssr-client/lit-element-hydrate-support.js',
                      ),
                      { dev: development },
                    )
                  : '';
              let markup;
              if (mode === 'ssr-only') {
                markup = f.ssr('content', template);
              } else if (mode === 'csr-only') {
                markup = f.csr(
                  'content',
                  `<${name}-content version="${version}" locale='${locale}' translations='${translations}' initial-state='${initialState}'></${name}-content>`,
                );
              } else {
                markup = f.hydrate('content', template);
              }

              reply
                .type('text/html; charset=utf-8')
                .send(`${hydrateSupport}${markup}`);

              return reply;
            } catch (err) {
              f.log.error(err);
              return reply;
            }
          });
        }

        if (existsSync(fallbackFilePath)) {
          const tag = unsafeStatic(`${name}-fallback`);
          f.get(f.podlet.fallback(), async (request, reply) => {
            try {
              const contextConfig = /** @type {FastifyContextConfig} */ (
                reply.context.config
              );
              contextConfig.timing = true;

              if (mode === 'ssr-only' || mode === 'hydrate') {
                // import server side component
                await f.importElement(fallbackFilePath);
              }

              const initialState = JSON.stringify(
                // @ts-ignore
                (await fallbackStateFn(request, reply.app.podium.context)) ||
                  '',
              );

              const messages = await f.readTranslations();

              const translations = messages ? JSON.stringify(messages) : '';
              const template = html`
                  <${tag} version="${version}" locale='${locale}' translations='${translations}'
                          initial-state='${initialState}'></${tag}>${null} `;
              const hydrateSupport =
                mode === 'hydrate'
                  ? f.script(
                      joinURLPathSegments(
                        prefix,
                        '/_/dynamic/modules/@lit-labs/ssr-client/lit-element-hydrate-support.js',
                      ),
                      { dev: development },
                    )
                  : '';
              let markup;
              if (mode !== 'ssr-only') {
                markup = f.ssr('fallback', template);
              } else if (mode === 'csr-only') {
                markup = f.csr(
                  'fallback',
                  `<${name}-fallback version="${version}" locale='${locale}' translations='${translations}' initial-state='${initialState}'></${name}-fallback>`,
                );
              } else {
                markup = f.hydrate('fallback', template);
              }
              reply
                .type('text/html; charset=utf-8')
                .send(`${hydrateSupport}${markup}`);

              return reply;
            } catch (err) {
              f.log.error(err);
              return reply;
            }
          });
        }

        // expose decorators to outer plugin wrapper

        podlet = f.podlet;
        metrics = f.metrics;
        schemas = f.schemas;
      },
      { prefix },
    );

    // Expose developer facing APIs using decorate
    /**
     * @typedef {(req: import('fastify').FastifyRequest, context: any) => Promise<{ [key: string]: any; [key: number]: any; } | null>} stateFunction
     */

    /**
     * @param {stateFunction} stateFunction
     */
    function setContentState(stateFunction) {
      contentStateFn = stateFunction;
    }

    /**
     * @param {stateFunction} stateFunction
     */
    function setFallbackState(stateFunction) {
      fallbackStateFn = stateFunction;
    }

    fastify.decorate('setContentState', setContentState);
    fastify.decorate('setFallbackState', setFallbackState);
    fastify.decorate('podlet', podlet);
    fastify.decorate('metrics', metrics);
    fastify.decorate('schemas', schemas);
  },
);
