import { APIGatewayProxyEventV2, APIGatewayProxyResult, Context } from "https://deno.land/x/lambda/mod.ts";
import { Request } from './api.ts';
import { Project } from "./project.ts";
import { handleRequest } from "./server.ts";
import { encode, path, ServerRequest } from './std.ts';
import util from "./util.ts";

let project: Project

export async function handler(
    event: APIGatewayProxyEventV2,
    context: Context,
): Promise<APIGatewayProxyResult> {
    const [protoMajor, protoMinor] = event.requestContext.http.protocol.substr(5, 3).split('.')
    const req = {
        url: event.rawPath,
        proto: event.requestContext.http.protocol,
        protoMajor: parseInt(protoMajor, 10),
        protoMinor: parseInt(protoMinor, 10),
        method: event.requestContext.http.method,
        headers: new Headers(event.headers),
    } as ServerRequest;
    if (project === undefined) {
        project = new Project(path.resolve('.'), 'production')
        await project.ready
    }
    const url = new URL('http://localhost/' + req.url)
    const pathname = util.cleanPath(url.pathname)
    const resp = new Request(req, pathname, {}, url.searchParams)
    const result = await handleRequest(req, resp, url, project)
    const ret: APIGatewayProxyResult = {
        statusCode: result.status || 0,
        body: '',
    }
    if (typeof result.body === 'string') {
        ret.body = result.body
    }
    if (result.body instanceof Uint8Array) {
        ret.isBase64Encoded = true
        ret.body = encode(result.body)
    }
    return ret;
}