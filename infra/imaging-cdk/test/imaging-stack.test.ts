import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ImagingStack } from "../lib/imaging-stack.js";

function synthesize(): Record<string, any> {
    const directory = mkdtempSync(join(tmpdir(), "modelforge-imaging-cdk-"));
    try {
        const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const publicKeyPath = join(directory, "signing-public-key.pem");
        writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
        const app = new App();
        const stack = new ImagingStack(app, "TestImagingStack", {
            env: { account: "111111111111", region: "eu-central-1" },
            signingPublicKeyPath: publicKeyPath,
            bucketNamePrefix: "modelforge-imaging-test",
        });
        return Template.fromStack(stack).toJSON();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("keeps ACLs enabled only on the dedicated CloudFront log bucket", () => {
    const template = synthesize();
    const resources = template.Resources as Record<string, any>;
    const imagingBucket = Object.values(resources).find((resource: any) =>
        resource.Type === "AWS::S3::Bucket" && resource.Properties?.LoggingConfiguration
    ) as any;
    assert.ok(imagingBucket, "expected the imaging bucket with server-access logging");

    const logBucketId = imagingBucket.Properties.LoggingConfiguration.DestinationBucketName.Ref;
    const logBucket = resources[logBucketId];
    assert.deepEqual(logBucket.Properties.OwnershipControls.Rules, [{ ObjectOwnership: "ObjectWriter" }]);
    assert.deepEqual(imagingBucket.Properties.OwnershipControls.Rules, [{ ObjectOwnership: "BucketOwnerEnforced" }]);
    assert.deepEqual(logBucket.Properties.PublicAccessBlockConfiguration, {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
    });
});

test("uses the OAC-generated account-scoped KMS grant without a distribution dependency cycle", () => {
    const template = synthesize();
    const key = Object.values(template.Resources as Record<string, any>).find((resource: any) => resource.Type === "AWS::KMS::Key") as any;
    assert.ok(key, "expected a customer-managed KMS key");
    const cloudFrontStatements = key.Properties.KeyPolicy.Statement.filter(
        (statement: any) => statement.Principal?.Service === "cloudfront.amazonaws.com"
    );
    assert.equal(cloudFrontStatements.length, 1);
    assert.deepEqual(
        cloudFrontStatements[0].Condition.ArnLike["AWS:SourceArn"],
        {
            "Fn::Join": [
                "",
                [
                    "arn:",
                    { Ref: "AWS::Partition" },
                    ":cloudfront::",
                    { Ref: "AWS::AccountId" },
                    ":distribution/*",
                ],
            ],
        }
    );
});

test("keeps CloudFormation descriptions within the supported character set", () => {
    const template = synthesize();
    for (const resource of Object.values(template.Resources as Record<string, any>) as any[]) {
        const description = resource.Properties?.Description;
        if (description === undefined) continue;
        assert.match(description, /^[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*$/);
    }
});
