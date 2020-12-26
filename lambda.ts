import {APIGatewayProxyEventV2, APIGatewayProxyResult, Context,} from "https://deno.land/x/lambda/mod.ts";
import {path, ServerRequest, Response, encode} from './std.ts'
import {handleRequest} from "./server.ts";
import {Project} from "./project.ts";

let project: Project

async function handler(
    event: APIGatewayProxyEventV2,
    context: Context,
): Promise<APIGatewayProxyResult> {
    return new Promise(async resolve => {
        const [protoMajor, protoMinor] = event.requestContext.http.protocol.substr(5, 3).split('.')
        const req = {
            url: event.rawPath,
            proto: event.requestContext.http.protocol,
            protoMajor: parseInt(protoMajor, 10),
            protoMinor: parseInt(protoMinor, 10),
            method: event.requestContext.http.method,
            headers: new Headers(event.headers),
            async respond(r: Response): Promise<void> {
                const ret: APIGatewayProxyResult = {
                    statusCode: r.status || 0,
                    body: '',
                }
                if (typeof r.body === 'string') {
                    ret.body = r.body
                }
                if (r.body instanceof Uint8Array) {
                    ret.isBase64Encoded = true
                    ret.body = encode(r.body)
                }
                resolve(ret)
            }
        } as ServerRequest;
        if (project === undefined) {
            project = new Project(path.resolve('.'), 'production')
            await project.ready
        }
        await handleRequest(req, project)
    })
}