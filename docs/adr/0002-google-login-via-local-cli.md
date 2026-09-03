# Google login through a CLI command with an ephemeral localhost server

Search Console and Analytics tools need the Operator's Google OAuth tokens, and
Google retired the out-of-band copy-paste flow in 2022, so the consent redirect needs
somewhere to land. A `login` command opens the browser, receives the code on
`http://localhost:<port>/callback` from an HTTP server it starts and then shuts down,
and writes the tokens to the `config` table. Refresh happens internally from then on.

This is the pattern `gcloud`, `gh` and `vercel` use, and it means **the documentation
must instruct Operators to create a Google Cloud OAuth client of type "Desktop app"**
— that client type is what permits a localhost redirect.

## Consequences

The client type is baked into every Operator's Google Cloud project, so changing this
flow later invalidates the setup of everyone who already authorized. The setup
documentation is part of the product, not an afterthought: an Operator cannot reach
the Full Report tools without following it correctly.
