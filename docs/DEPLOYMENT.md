# Deployment setup

이 프로젝트는 GitHub Actions만으로 배포합니다. 로컬에서 AWS·Cloudflare 배포 명령을 실행하지 않습니다.

## Trigger policy

- Pull request: `lint`, `typecheck`, `test`, `build`만 수행한다.
- `master` push: 검증 성공 후 Worker와 정적 assets를 production 환경으로 배포한다.
- 수동 실행과 다른 브랜치의 배포 트리거는 설정하지 않았다.

## One-time GitHub configuration

연결할 GitHub 저장소에서 다음 값을 설정한 후에만 `master`에 푸시한다.

| Location | Name | Value |
| --- | --- | --- |
| Actions secret | `CLOUDFLARE_API_TOKEN` | 배포 대상 계정에 최소 권한으로 범위를 제한한 Worker 배포 토큰 |
| Actions secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 계정 ID |
| Actions variable | `D1_DATABASE_ID` | HomeMeasure D1 데이터베이스 ID |

`infra/worker/wrangler.jsonc`의 R2 bucket 이름이 실제 버킷 이름과 같아야 합니다.

## Worker OAuth environment

Google Cloud Console에서 OAuth **Web application** client를 만들고, 배포할 Worker의 정확한 `https://<host>/api/auth/google/callback`를 authorized redirect URI로 등록한다. Worker runtime에는 아래 값을 설정한다. 실제 값을 저장소, `wrangler.jsonc`, GitHub Actions 로그에 기록하지 않는다.

| Worker binding | Classification | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | runtime variable | Google OAuth client ID |
| `OAUTH_REDIRECT_URI` | runtime variable | Google Console에 등록한 정확한 callback URL |
| `GOOGLE_CLIENT_SECRET` | Worker secret | OAuth authorization-code exchange credential |

세 값 중 하나라도 없거나 callback URL이 `https`(localhost 개발용 `http` 예외)와 `/api/auth/google/callback` 형식을 만족하지 않으면 OAuth endpoints만 `503`으로 fail-closed 된다. D1에는 short-lived OAuth transaction과 opaque session ID만 저장하며, Google access token·refresh token·ID token은 저장하지 않는다.

## Safety boundary

`D1_DATABASE_ID`가 비어 있으면 deploy job은 Worker 배포 단계 전에 실패합니다. 이 가드는 인프라 식별자가 설정되지 않은 상태에서 의도치 않은 배포가 발생하는 것을 막습니다.

Cloudflare의 GitHub Actions 안내도 CI에는 API token과 account ID를 secret으로 두고 Worker 배포 action을 사용하도록 설명합니다. [Cloudflare Workers GitHub Actions 문서](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
