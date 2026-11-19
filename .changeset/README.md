# Changesets

Run `npx changeset` in a PR that changes the published package, describe the
change and pick the semver bump. On merge to `main`, the release workflow opens
a "Version Packages" PR; merging that PR publishes to npm.
