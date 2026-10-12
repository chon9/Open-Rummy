# Deploying Open Rummy to an AWS Lightsail container service

This is the managed alternative to a Lightsail instance. Lightsail runs the Docker image,
terminates HTTPS and gives you a `*.cs.amazonlightsail.com` URL. You don't have to manage a VM,
nginx or certbot.

The game keeps rooms in memory, so run **one node** (`--scale 1`). With more nodes, players in
the same room could land on different containers.

## Prerequisites

- Docker (Docker Desktop on Windows).
- AWS CLI v2, signed in with `aws configure` or `aws sso login`. Keep the credentials in your
  AWS CLI profile; never put them in this repo or in the image.
- The `lightsailctl` plugin, which `push-container-image` needs. To install it, see the AWS docs
  page "Installing the Lightsail container services plugin".
- Pick a region, e.g. `ap-southeast-1` (Singapore). It is the closest region to Malaysia.

```bash
export AWS_REGION=ap-southeast-1
```

## 1. Build and test the image locally

```bash
docker build -t open-rummy:latest .
docker run --rm -p 8080:8080 open-rummy:latest
# another terminal:
curl -fsS http://localhost:8080/healthz
# then open http://localhost:8080 in a browser, and stop the container with Ctrl+C
```

## 2. Create the container service (once)

`nano` (512 MB, 0.25 vCPU) is enough for small groups of friends. Use `micro` for more rooms.

```bash
aws lightsail create-container-service \
  --service-name open-rummy \
  --power nano \
  --scale 1
```

Wait until `aws lightsail get-container-services --service-name open-rummy` reports
`"state": "READY"`. This takes a few minutes.

## 3. Push the image

```bash
aws lightsail push-container-image \
  --service-name open-rummy \
  --label web \
  --image open-rummy:latest
```

The command prints a reference like `:open-rummy.web.1`. The number goes up on each push. Use
that exact string as `image` below.

## 4. Deploy

Create `containers.json` **outside the repo** or delete it afterwards. It has no secrets, but it
is environment-specific.

```json
{
  "web": {
    "image": ":open-rummy.web.1",
    "ports": { "8080": "HTTP" },
    "environment": {
      "NODE_ENV": "production",
      "HOST": "0.0.0.0",
      "PORT": "8080",
      "WEB_ROOT": "/app/web",
      "MAX_ROOMS": "200",
      "ALLOWED_ORIGINS": "https://open-rummy.xxxxxxxxxxxx.ap-southeast-1.cs.amazonlightsail.com",
      "TRUST_PROXY": "1"
    }
  }
}
```

Create `public-endpoint.json`:

```json
{
  "containerName": "web",
  "containerPort": 8080,
  "healthCheck": {
    "path": "/healthz",
    "intervalSeconds": 10,
    "timeoutSeconds": 5,
    "healthyThreshold": 2,
    "unhealthyThreshold": 3,
    "successCodes": "200"
  }
}
```

Then deploy:

```bash
aws lightsail create-container-service-deployment \
  --service-name open-rummy \
  --containers file://containers.json \
  --public-endpoint file://public-endpoint.json
```

The service URL is in `aws lightsail get-container-services --service-name open-rummy`, under the
`url` field. Put that origin, without a trailing slash, into `ALLOWED_ORIGINS` and deploy again.

To update later, rebuild, push again (you get a new `:open-rummy.web.N`), change `image` in
`containers.json`, and run `create-container-service-deployment` again.

## Custom domain

```bash
aws lightsail create-certificate \
  --certificate-name open-rummy-cert \
  --domain-name rummy.example.com
# add the DNS validation CNAME records it shows, wait for ISSUED, then:
aws lightsail update-container-service \
  --service-name open-rummy \
  --public-domain-names '{"open-rummy-cert": ["rummy.example.com"]}'
```

Point a CNAME for `rummy.example.com` at the service's default domain. Then add
`https://rummy.example.com` to `ALLOWED_ORIGINS`.

## Notes

- **TRUST_PROXY.** The image sets `TRUST_PROXY=1` by default (the server itself defaults to
  `0`). The container service reaches the container only through its load balancer, which
  appends the real client address to `X-Forwarded-For`; with `1` the per-IP limits
  (`MAX_CONNS_PER_IP`, `MAX_ROOMS_PER_IP`, join throttling) see each player instead of the
  balancer. If you run the image with its port open to the internet (`docker run -p ...`
  on a public host), pass `-e TRUST_PROXY=0` so clients cannot spoof their address. The other
  limits (`MAX_CONNECTIONS` 4000, `MAX_CONNS_PER_IP` 20, `MAX_ROOMS_PER_IP` 5) can be set in
  `environment` too; see [.env.example](../.env.example).
- **WebSockets.** The game needs `/ws` WebSocket upgrades through the public endpoint. After the
  first deployment, check that an online room connects (browser DevTools > Network > WS). If
  your service drops long-lived connections, use the instance option in the README
  (nginx + systemd). That option is fully under your control.
- **Logs:** `aws lightsail get-container-log --service-name open-rummy --container-name web`
- **Cost:** a container service is billed for every hour it exists, even when it is idle.
  Delete it with `aws lightsail delete-container-service --service-name open-rummy`.
- The image runs as the unprivileged `node` user. It holds only the server bundle and the static
  client, and contains no credentials.
