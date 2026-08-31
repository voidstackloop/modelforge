import * as fs from "node:fs";
import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration, aws_s3 as s3, aws_kms as kms, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_iam as iam } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * Provisions exactly the resources docs/IMAGING.md's "Required AWS
 * resources" table specifies for server/'s S3ImagingObjectStore — nothing
 * more (no ECS service/task definition; this stack hands back a role with
 * the right permissions for whatever compute actually runs `server/`, per
 * this directory's README). Every property below is a direct translation
 * of that table's requirement column; see it before changing anything here.
 *
 * The CloudFront signing key pair's PRIVATE half never appears in this file
 * or anywhere CDK/CloudFormation would persist it — see this directory's
 * README for how it's generated and handed to the server out of band. Only
 * the PUBLIC half (a PEM file path, supplied via CDK context) is read here.
 */
export interface ImagingStackProps extends StackProps {
    /** Path to the RSA-2048 public key PEM for the CloudFront signing key
     * pair (see README.md's "Generate the signing key pair" step). Read at
     * synth time, embedded in the CloudFormation template as the
     * CloudFront public key resource's content — this is the public half
     * only, safe to embed. */
    signingPublicKeyPath: string;
    /** Prefix for the bucket name (a real deployment's bucket names must be
     * globally unique across all of S3) — e.g. "modelforge-imaging-prod". */
    bucketNamePrefix: string;
}

export class ImagingStack extends Stack {
    constructor(scope: Construct, id: string, props: ImagingStackProps) {
        super(scope, id, props);

        if (!fs.existsSync(props.signingPublicKeyPath)) {
            throw new Error(
                `signingPublicKeyPath does not exist: ${props.signingPublicKeyPath}\n` +
                    "Generate the CloudFront signing key pair first — see infra/imaging-cdk/README.md."
            );
        }
        const signingPublicKeyPem = fs.readFileSync(props.signingPublicKeyPath, "utf8");

        // Customer-managed CMK, rotation enabled. Grants are added below
        // once the bucket and distribution exist, scoped exactly to the
        // two principals the table calls for — nothing broader.
        const cmk = new kms.Key(this, "ImagingCmk", {
            description: "CMK for ModelForge imaging object storage (DICOM instances) — see docs/IMAGING.md",
            enableKeyRotation: true,
            removalPolicy: RemovalPolicy.RETAIN,
        });

        // Separate bucket for CloudFront access logs, per the table's
        // "access logging to a separate log bucket" requirement — never the
        // imaging bucket itself, so a misconfigured log-read grant can
        // never expose PHI-bearing object content.
        const accessLogBucket = new s3.Bucket(this, "ImagingAccessLogBucket", {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            lifecycleRules: [{ expiration: Duration.days(365) }],
            removalPolicy: RemovalPolicy.RETAIN,
        });

        const bucket = new s3.Bucket(this, "ImagingBucket", {
            bucketName: `${props.bucketNamePrefix}-${this.account}-${this.region}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            versioned: true,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: cmk,
            enforceSSL: true,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            serverAccessLogsBucket: accessLogBucket,
            serverAccessLogsPrefix: "s3/",
            removalPolicy: RemovalPolicy.RETAIN,
        });

        // RSA-2048 public key + trusted key group — "an untrusted-key-group
        // distribution serves everything to everyone" (docs/IMAGING.md).
        // The private half this pairs with never appears here; see the
        // constructor's own guard above and this directory's README.
        const signingPublicKey = new cloudfront.PublicKey(this, "ImagingSigningPublicKey", {
            encodedKey: signingPublicKeyPem,
        });
        const keyGroup = new cloudfront.KeyGroup(this, "ImagingSigningKeyGroup", {
            items: [signingPublicKey],
        });

        const distribution = new cloudfront.Distribution(this, "ImagingDistribution", {
            comment: "ModelForge imaging (DICOM) content delivery — see docs/IMAGING.md",
            defaultBehavior: {
                // withOriginAccessControl(): OAC, not the legacy OAI this
                // table explicitly rules out — CDK wires the bucket policy
                // to trust only this exact distribution automatically.
                origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
                trustedKeyGroups: [keyGroup],
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
            },
            logBucket: accessLogBucket,
            logFilePrefix: "cloudfront/",
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        });

        // KMS grants: exactly the two principals the table names, nothing
        // broader. The CloudFront OAC service principal is scoped to this
        // one distribution's ARN — not "any CloudFront distribution in this
        // account" — via aws:SourceArn, the standard pattern for an
        // OAC-fronted, KMS-encrypted S3 origin.
        cmk.grant(
            new iam.ServicePrincipal("cloudfront.amazonaws.com", {
                conditions: { StringEquals: { "aws:SourceArn": `arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}` } },
            }),
            "kms:Decrypt"
        );

        // Server task role: s3:PutObject/GetObject/DeleteObject on the
        // bucket prefix, plus the KMS grants above. Explicitly NOT
        // s3:PutBucketPolicy or any CloudFront mutation permission (the
        // table's own "No" column) — attach this role to whatever compute
        // identity actually runs server/ (see README.md).
        const serverTaskRole = new iam.Role(this, "ImagingServerTaskRole", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
            description: "Least-privilege role for the server/ process's S3ImagingObjectStore — attach to whatever compute actually runs it (see infra/imaging-cdk/README.md).",
        });
        bucket.grantPut(serverTaskRole);
        bucket.grantRead(serverTaskRole);
        bucket.grantDelete(serverTaskRole);
        cmk.grant(serverTaskRole, "kms:Decrypt", "kms:GenerateDataKey");

        new CfnOutput(this, "ImagingS3Bucket", { value: bucket.bucketName, description: "IMAGING_S3_BUCKET" });
        new CfnOutput(this, "ImagingS3KmsKeyId", { value: cmk.keyArn, description: "IMAGING_S3_KMS_KEY_ID" });
        new CfnOutput(this, "ImagingS3Region", { value: this.region, description: "IMAGING_S3_REGION" });
        new CfnOutput(this, "ImagingCloudFrontDomain", { value: distribution.distributionDomainName, description: "IMAGING_CLOUDFRONT_DOMAIN" });
        new CfnOutput(this, "ImagingCloudFrontKeyPairId", { value: signingPublicKey.publicKeyId, description: "IMAGING_CLOUDFRONT_KEY_PAIR_ID" });
        new CfnOutput(this, "ImagingServerTaskRoleArn", { value: serverTaskRole.roleArn, description: "Attach this role to the compute running server/" });
    }
}
