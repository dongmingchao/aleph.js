import { writeResponse } from 'https://deno.land/std@0.78.0/http/_io.ts'
import { Request } from './api.ts'
import { existsFileSync } from './fs.ts'
import { createHtml } from './html.ts'
import log from './log.ts'
import { getContentType } from './mime.ts'
import { injectHmr, Project } from './project.ts'
import { path, Response, serve, ServerRequest, ws } from './std.ts'
import util, { hashShort } from './util.ts'

export async function handleRequest(
    req: ServerRequest,
    resp: Request,
    url: URL,
    project: Project,
    isDev = false,
) {
    return new Promise<Response>(async resolve => {
        resp.respond = async function (r) {
            let err: Error | undefined;
            try {
                resolve(r)
            } catch (e) {
                try {
                    // Eagerly close on error.
                    this.conn.close();
                } catch {
                    // Pass
                }
                err = e;
            }
            // Signal that this request has been processed and the next pipelined
            // request on the same connection can be accepted.
            this.done.resolve(err);
            if (err) {
                // Error during responding, rethrow.
                throw err;
            }
        }
        try {
            // serve hmr ws
            if (resp.pathname === '/_hmr') {
                const { conn, r: bufReader, w: bufWriter, headers } = req
                ws.acceptWebSocket({ conn, bufReader, bufWriter, headers }).then(async socket => {
                    const watcher = project.createFSWatcher()
                    watcher.on('add', (moduleId: string, hash: string) => socket.send(JSON.stringify({
                        type: 'add',
                        moduleId,
                        hash
                    })))
                    watcher.on('remove', (moduleId: string) => {
                        watcher.removeAllListeners('modify-' + moduleId)
                        socket.send(JSON.stringify({
                            type: 'remove',
                            moduleId
                        }))
                    })
                    for await (const e of socket) {
                        if (util.isNEString(e)) {
                            try {
                                const data = JSON.parse(e)
                                if (data.type === 'hotAccept' && util.isNEString(data.id)) {
                                    const mod = project.getModule(data.id)
                                    if (mod) {
                                        watcher.on('modify-' + mod.id, (hash: string) => socket.send(JSON.stringify({
                                            type: 'update',
                                            moduleId: mod.id,
                                            hash,
                                            updateUrl: util.cleanPath(`${project.config.baseUrl}/_aleph/${mod.id.replace(/\.js$/, '')}.${hash!.slice(0, hashShort)}.js`)
                                        })))
                                    }
                                }
                            } catch (e) { }
                        } else if (ws.isWebSocketCloseEvent(e)) {
                            break
                        }
                    }
                    project.removeFSWatcher(watcher)
                })
                return
            }

            // serve public files
            const filePath = path.join(project.appRoot, 'public', decodeURI(resp.pathname))
            if (existsFileSync(filePath)) {
                const info = Deno.lstatSync(filePath)
                const lastModified = info.mtime?.toUTCString() ?? new Date().toUTCString()
                if (lastModified === req.headers.get('If-Modified-Since')) {
                    resp.status(304).send('')
                    return
                }

                const body = Deno.readFileSync(filePath)
                resp.setHeader('Last-Modified', lastModified)
                resp.send(body, getContentType(filePath))
                return
            }

            // serve APIs
            if (resp.pathname.startsWith('/api/')) {
                project.callAPI(req, { pathname: resp.pathname, search: url.search })
                return
            }

            // serve dist files
            if (resp.pathname.startsWith('/_aleph/')) {
                if (resp.pathname.startsWith('/_aleph/data/') && resp.pathname.endsWith('/data.js')) {
                    const [p, s] = util.splitBy(util.trimSuffix(util.trimPrefix(resp.pathname, '/_aleph/data'), '/data.js'), '@')
                    const [status, data] = await project.getSSRData({ pathname: p, search: s })
                    if (status === 200) {
                        resp.send(`export default ` + JSON.stringify(data), 'application/javascript; charset=utf-8')
                    } else {
                        resp.status(status).send('')
                    }
                    return
                } else if (resp.pathname.endsWith('.css')) {
                    const filePath = path.join(project.buildDir, util.trimPrefix(resp.pathname, '/_aleph/'))
                    if (existsFileSync(filePath)) {
                        const body = await Deno.readFile(filePath)
                        resp.send(body, 'text/css; charset=utf-8')
                        return
                    }
                } else {
                    const reqSourceMap = resp.pathname.endsWith('.js.map')
                    const mod = project.getModuleByPath(reqSourceMap ? resp.pathname.slice(0, -4) : resp.pathname)
                    if (mod) {
                        const etag = req.headers.get('If-None-Match')
                        if (etag && etag === mod.hash) {
                            resp.status(304).send('')
                            return
                        }

                        let body = ''
                        if (reqSourceMap) {
                            body = mod.jsSourceMap
                        } else {
                            body = mod.jsContent
                            if (project.isHMRable(mod.id) && isDev) {
                                body = injectHmr({ ...mod, jsContent: body })
                            }
                        }
                        resp.setHeader('ETag', mod.hash)
                        resp.send(body, `application/${reqSourceMap ? 'json' : 'javascript'}; charset=utf-8`)
                        return
                    }
                }
            }

            // ssr
            const [status, html] = await project.getPageHtml({ pathname: resp.pathname, search: url.search })
            resp.status(status).send(html, 'text/html; charset=utf-8')
        } catch (err) {
            resp.status(500).send(createHtml({
                lang: 'en',
                head: ['<title>500 - internal server error</title>'],
                body: `<p><strong><code>500</code></strong><small> - </small><span>${err.message}</span></p>`
            }), 'text/html; charset=utf-8')
        }

    })
}

export async function start(appDir: string, hostname: string, port: number, isDev = false, reload = false) {
    const project = new Project(appDir, isDev ? 'development' : 'production', reload)
    await project.ready

    while (true) {
        try {
            const s = serve({ hostname, port })
            log.info(`Server ready on http://${hostname}:${port}`)
            for await (const req of s) {
                const url = new URL('http://localhost/' + req.url)
                const pathname = util.cleanPath(url.pathname)
                const resp = new Request(req, pathname, {}, url.searchParams)
                const result = await handleRequest(req, resp, url, project, isDev)
                await writeResponse(resp.w, result);
            }
        } catch (err) {
            if (err instanceof Deno.errors.AddrInUse) {
                log.warn(`port ${port} already in use, try ${port + 1}`)
                port++
            } else {
                log.fatal(err.message)
            }
        }
    }
}
