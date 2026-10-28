# Third-party notice: elkjs

`elk.bundled.js` in this directory is a verbatim, unmodified copy of a third-party library.

| Field | Value |
| --- | --- |
| Package | `elkjs` (the Eclipse Layout Kernel, compiled to JavaScript) |
| Version | 0.12.0 (published 2026-07-17) |
| Source | https://registry.npmjs.org/elkjs/-/elkjs-0.12.0.tgz (`npm pack elkjs@0.12.0`), file `package/lib/elk.bundled.js` |
| Project | https://github.com/kieler/elkjs and https://www.eclipse.org/elk/ |
| File | `assets/viewer/elk.bundled.js` |
| SHA-256 | `1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3` |
| Size | 1609707 bytes |

Verify with `shasum -a 256 assets/viewer/elk.bundled.js`.

## License

The package declares the dual license `EPL-2.0 OR GPL-3.0-or-later`. This project elects the
**Eclipse Public License, Version 2.0 (EPL-2.0)** for elkjs. The EPL-2.0 text is at
https://www.eclipse.org/legal/epl-2.0 and ships in the elkjs package as `LICENSE.md`.

The notice carried in the file itself:

> Copyright (c) 2017 Kiel University and others.
> Copyright (c) 2021 Kiel University and others.
>
> This program and the accompanying materials are made available under the terms of the
> Eclipse Public License 2.0 which is available at https://www.eclipse.org/legal/epl-2.0.
>
> SPDX-License-Identifier: EPL-2.0 OR GPL-3.0-or-later

The package author line is "Ulf Rüegg". elkjs is not modified here, so the EPL-2.0 source-availability
obligation is met by the upstream sources linked above. Do not edit `elk.bundled.js`; to update it,
vendor a new exact version and update this notice and the hash together.

## Not a dependency

elkjs is vendored as a file. There is no `package.json` dependency and no `npm install` step: the
repository stays zero-npm-dependency.
