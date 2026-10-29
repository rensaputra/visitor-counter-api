# AWS OIDC Setup for GitHub Actions

One-time, manual AWS setup that lets this repo's GitHub Actions workflow deploy
via short-lived credentials (GitHub OIDC) instead of stored AWS access keys.

> **Run these once, by a human with admin access to the AWS account.** The CI
> pipeline never creates or modifies these resources. Nothing here is executed
> by the workflow — it only _assumes_ the roles created below.

## What you create

1. An IAM **OIDC identity provider** for GitHub's token issuer.
2. A **dev deploy role** whose trust policy only accepts tokens from this repo
   on the `main` branch.
3. A **prod deploy role** whose trust policy only accepts tokens from this repo
   via the GitHub `production` **Environment**.

## Prerequisites / conventions

- AWS CLI configured with an admin profile.
- Repo: `rensaputra/visitor-counter-api`
- Region: `ap-southeast-2` (roles are global; region matters for deploys)
- Stacks: `visitor-counter-dev`, `visitor-counter-prod`

Set these shell variables to follow along (replace `AWS_ACCOUNT_ID`):

```bash
export AWS_ACCOUNT_ID="111122223333"
export GITHUB_ORG="rensaputra"
export GITHUB_REPO="visitor-counter-api"
export AWS_REGION="ap-southeast-2"
```

> **Important — immutable subject claims.** Since 15 July 2026, GitHub issues
> OIDC tokens with an _immutable_ `sub` claim that embeds numeric owner and
> repository IDs instead of the plain `owner/repo` name, e.g.
> `repo:rensaputra@1814138/visitor-counter-api@1374245399:ref:refs/heads/main`.
> This repo uses that format, and once immutable subjects are enabled the
> setting cannot be turned off. The trust policies below are written against the
> immutable `sub`. Look up your own IDs before copying them:
>
> ```bash
> # The sub_claim_prefix field is the immutable "repo:OWNER@ID/REPO@ID" string.
> gh api repos/$GITHUB_ORG/$GITHUB_REPO/actions/oidc/customization/sub
> ```
>
> Append `:ref:refs/heads/main` (dev) or `:environment:production` (prod) to that
> prefix. If your repo predates the change and still issues name-based subjects,
> use `repo:$GITHUB_ORG/$GITHUB_REPO:...` instead.

---

## 1. Create the GitHub OIDC identity provider

GitHub's OIDC issuer is `https://token.actions.githubusercontent.com` with
audience `sts.amazonaws.com`. Create the provider once per account (skip if it
already exists — check with `aws iam list-open-id-connect-providers`):

```bash
aws iam create-open-id-connect-provider \
  --url "https://token.actions.githubusercontent.com" \
  --client-id-list "sts.amazonaws.com"
```

Modern AWS STS validates GitHub's certificate against Amazon's trusted CA store,
so a `--thumbprint-list` is no longer required. If your tooling insists on one,
pass any non-empty placeholder (e.g. `ffffffffffffffffffffffffffffffffffffffff`).

Record the provider ARN; it has the form:

```
arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
```

---

## 2. Create the dev deploy role

**Trust policy** — accepts OIDC tokens from this repo **on the `main` branch
only**. Save as `trust-dev.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:rensaputra@1814138/visitor-counter-api@1374245399:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

Create the role:

```bash
sed "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" trust-dev.json > trust-dev.resolved.json

aws iam create-role \
  --role-name visitor-counter-deploy-dev \
  --assume-role-policy-document file://trust-dev.resolved.json \
  --description "GitHub Actions OIDC deploy role for visitor-counter dev stack"
```

---

## 3. Create the prod deploy role

**Trust policy** — accepts OIDC tokens from this repo via the `production`
**Environment** only. The GitHub Environment's required-reviewers gate (step 5)
is what forces manual approval before this role can ever be assumed. Save as
`trust-prod.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:rensaputra@1814138/visitor-counter-api@1374245399:environment:production"
        }
      }
    }
  ]
}
```

Create the role:

```bash
sed "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" trust-prod.json > trust-prod.resolved.json

aws iam create-role \
  --role-name visitor-counter-deploy-prod \
  --assume-role-policy-document file://trust-prod.resolved.json \
  --description "GitHub Actions OIDC deploy role for visitor-counter prod stack"
```

---

## 4. Attach the deploy permissions policy

Both roles need the same permission set: deploy the SAM/CloudFormation stack,
manage the Lambda + HTTP API + DynamoDB resources it owns, and use the SAM
managed S3 bucket (`resolve_s3 = true`) for artifact upload.

The policy below is scoped to this project's resource name prefixes
(`visitor-counter-*`) where the API allows ARN-level scoping. Some SAM actions
(e.g. the managed-bucket bootstrap and certain read/describe calls) require
account-wide access and are grouped separately. Review against your account's
security posture before attaching — tighten further if your org requires it.

Save as `deploy-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationStack",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStackResources",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet"
      ],
      "Resource": [
        "arn:aws:cloudformation:ap-southeast-2:AWS_ACCOUNT_ID:stack/visitor-counter-*/*",
        "arn:aws:cloudformation:ap-southeast-2:aws:transform/Serverless-2016-10-31"
      ]
    },
    {
      "Sid": "SamManagedBucket",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
        "s3:PutBucketTagging",
        "s3:PutEncryptionConfiguration",
        "s3:PutBucketVersioning",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::aws-sam-cli-managed-default-*",
        "arn:aws:s3:::aws-sam-cli-managed-default-*/*"
      ]
    },
    {
      "Sid": "LambdaManage",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:ListVersionsByFunction",
        "lambda:PublishVersion",
        "lambda:CreateAlias",
        "lambda:UpdateAlias",
        "lambda:DeleteAlias",
        "lambda:GetAlias",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags"
      ],
      "Resource": "arn:aws:lambda:ap-southeast-2:AWS_ACCOUNT_ID:function:visitor-counter-*"
    },
    {
      "Sid": "CodeDeployTrafficShift",
      "Effect": "Allow",
      "Action": [
        "codedeploy:CreateApplication",
        "codedeploy:DeleteApplication",
        "codedeploy:GetApplication",
        "codedeploy:CreateDeploymentGroup",
        "codedeploy:UpdateDeploymentGroup",
        "codedeploy:DeleteDeploymentGroup",
        "codedeploy:GetDeploymentGroup",
        "codedeploy:CreateDeployment",
        "codedeploy:GetDeployment",
        "codedeploy:GetDeploymentConfig",
        "codedeploy:RegisterApplicationRevision"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ApiGatewayHttpApi",
      "Effect": "Allow",
      "Action": [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PUT",
        "apigateway:PATCH",
        "apigateway:DELETE"
      ],
      "Resource": "arn:aws:apigateway:ap-southeast-2::*"
    },
    {
      "Sid": "DynamoDbTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeTable",
        "dynamodb:UpdateTable",
        "dynamodb:TagResource",
        "dynamodb:UntagResource",
        "dynamodb:ListTagsOfResource"
      ],
      "Resource": "arn:aws:dynamodb:ap-southeast-2:AWS_ACCOUNT_ID:table/visitor-counter-*"
    },
    {
      "Sid": "CloudWatchAlarms",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DescribeAlarms"
      ],
      "Resource": "arn:aws:cloudwatch:ap-southeast-2:AWS_ACCOUNT_ID:alarm:visitor-counter-*"
    },
    {
      "Sid": "IamForStackRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies"
      ],
      "Resource": "arn:aws:iam::AWS_ACCOUNT_ID:role/visitor-counter-*"
    },
    {
      "Sid": "LogsForLambda",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:DescribeLogGroups",
        "logs:PutRetentionPolicy",
        "logs:TagResource",
        "logs:ListTagsForResource"
      ],
      "Resource": "arn:aws:logs:ap-southeast-2:AWS_ACCOUNT_ID:log-group:/aws/lambda/visitor-counter-*"
    }
  ]
}
```

Attach it to both roles as an inline policy:

```bash
sed "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" deploy-policy.json > deploy-policy.resolved.json

for role in visitor-counter-deploy-dev visitor-counter-deploy-prod; do
  aws iam put-role-policy \
    --role-name "$role" \
    --policy-name visitor-counter-deploy \
    --policy-document file://deploy-policy.resolved.json
done
```

> **Note on scoping:** `CreateChangeSet`/`DescribeChangeSet` and a few SAM
> preflight calls may touch ARNs outside the `visitor-counter-*` prefix the
> first time a managed bucket is created. If a first deploy fails on an
> `AccessDenied` for an unexpected action, add that specific action rather than
> broadening to `"*"`. Capture the exact error from the CloudFormation events.
>
> **SAM managed bucket — bootstrap once, don't let CI touch it.** With
> `resolve_s3 = true`, SAM runs a `CreateChangeSet` against the
> `aws-sam-cli-managed-default` CloudFormation stack on _every_ deploy, which
> the scoped CI role is not allowed to do (it only covers `stack/visitor-counter-*`).
> Instead, bootstrap the managed bucket once with an admin profile:
>
> ```bash
> sam deploy --guided   # creates aws-sam-cli-managed-default + its S3 bucket
> ```
>
> Then pin that bucket in `samconfig.toml` with `s3_bucket = "<managed-bucket>"`
> and drop `resolve_s3`, so CI only ever operates on `visitor-counter-*`
> resources. The deploy policy's `SamManagedBucket` statement already grants
> object access to `aws-sam-cli-managed-default-*`, so no IAM change is needed.
> Look up the bucket name with `aws s3 ls | grep aws-sam-cli-managed`.

---

## 5. Configure the GitHub `production` Environment

The prod role's trust policy only accepts tokens issued for the `production`
environment, and that environment is where the manual approval lives:

1. In the repo: **Settings → Environments → New environment → `production`**.
2. Under **Deployment protection rules**, enable **Required reviewers** and add
   the people/teams who must approve each prod deploy.
3. (Optional) Restrict deployment branches to `main`.

With this in place, the `deploy-prod` job pauses for manual approval before it
can assume the prod role.

---

## 6. Wire the role ARNs into GitHub

The workflow reads the role ARNs from repository secrets. Add both (Settings →
Secrets and variables → Actions → New repository secret), or via CLI:

```bash
gh secret set AWS_DEPLOY_ROLE_DEV \
  --body "arn:aws:iam::$AWS_ACCOUNT_ID:role/visitor-counter-deploy-dev"

gh secret set AWS_DEPLOY_ROLE_PROD \
  --body "arn:aws:iam::$AWS_ACCOUNT_ID:role/visitor-counter-deploy-prod"
```

| Secret                  | Value                                                          |
| ----------------------- | ------------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_DEV`   | ARN of `visitor-counter-deploy-dev`                           |
| `AWS_DEPLOY_ROLE_PROD`  | ARN of `visitor-counter-deploy-prod`                          |

---

## 7. Verify

Push a commit to `main`. The pipeline should:

1. Pass the quality gate.
2. Assume the **dev** role, deploy `visitor-counter-dev`, and smoke-test the
   live dev endpoint.
3. Pause at `deploy-prod` for a required reviewer to approve.
4. On approval, assume the **prod** role and deploy `visitor-counter-prod`.

If a deploy fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`,
re-check the trust policy `sub` condition matches exactly: `...:ref:refs/heads/main`
for dev and `...:environment:production` for prod.

The most common cause is an **immutable subject claim mismatch**. If the trust
policy uses the plain `repo:OWNER/REPO:...` form but GitHub now issues the
immutable `repo:OWNER@<ownerId>/REPO@<repoId>:...` form (see the note at the top
of this file), the `sub` condition silently fails to match. Confirm the exact
`sub` GitHub issues and fix the trust policy to match it:

```bash
# Immutable prefix GitHub actually uses for this repo:
gh api repos/$GITHUB_ORG/$GITHUB_REPO/actions/oidc/customization/sub \
  --jq .sub_claim_prefix

# Inspect what the role currently trusts:
aws iam get-role --role-name visitor-counter-deploy-dev \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition'
```

Note: immutable subjects cannot be disabled once enabled — updating the trust
policy to the immutable `sub` is the fix, not reverting the GitHub setting.

## Cleanup (if tearing down)

```bash
for role in visitor-counter-deploy-dev visitor-counter-deploy-prod; do
  aws iam delete-role-policy --role-name "$role" --policy-name visitor-counter-deploy
  aws iam delete-role --role-name "$role"
done
# Only if no other integration uses it:
# aws iam delete-open-id-connect-provider \
#   --open-id-connect-provider-arn \
#   "arn:aws:iam::$AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
```
