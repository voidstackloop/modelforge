import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { ImagingStack } from "../lib/imaging-stack.js";

const app = new App();

const signingPublicKeyPath = app.node.tryGetContext("signingPublicKeyPath") ?? path.resolve(process.cwd(), "imaging-signing-key.pub.pem");
const bucketNamePrefix = app.node.tryGetContext("bucketNamePrefix") ?? "modelforge-imaging";

new ImagingStack(app, "ModelForgeImagingStack", {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
    signingPublicKeyPath,
    bucketNamePrefix,
});
