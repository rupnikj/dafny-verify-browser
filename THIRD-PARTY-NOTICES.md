# Third-party notices

This repository builds and redistributes (in the published GitHub Pages site
and any local `prototype/dist` output) compiled artifacts of the following
projects. All of them are MIT-licensed; the notices below are reproduced as
the license requires. The 58-line `patches/dafny-browser-compat.patch` is a
derivative of Dafny source and is likewise covered by Dafny's notice.

---

## Dafny

<https://github.com/dafny-lang/dafny> — pinned at
`a04eea4dab324219e438f94ccc5ff0abcad11d86` (4.11.0). Compiled to .NET
browser-wasm assemblies; `DafnyPrelude.bpl` is embedded verbatim as a resource.

> Dafny
>
> Copyright (c) Microsoft Corporation
>
> All rights reserved.
>
> MIT License
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the ""Software""), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
> the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
> FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
> IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Boogie

<https://github.com/boogie-org/boogie> — version 3.5.5, consumed as NuGet
packages and redistributed as compiled browser-wasm assemblies.

> Copyright (c) Microsoft Corporation
>
> All rights reserved.
>
> MIT License
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the ""Software""), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
> the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
> FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
> IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Z3

<https://github.com/Z3Prover/z3> — the official WebAssembly build shipped in
the `z3-solver` npm package, version 4.16.0 (the Z3 version Dafny 4.11 packages). Redistributed as `z3-built.js` /
`z3-built.wasm`.

> Z3
> Copyright (c) Microsoft Corporation
> All rights reserved.
> MIT License
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
> of the Software, and to permit persons to whom the Software is furnished to do
> so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## CodeMirror

<https://codemirror.net> — editor packages (`@codemirror/*`, `@lezer/*`)
bundled into the demo page's `app.js`.

> MIT License
>
> Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

## bignumber.js

<https://github.com/MikeMcl/bignumber.js> — arbitrary-precision arithmetic
for the Run feature: it is the one dependency of Dafny's JavaScript runtime
(`DafnyRuntime.js`), served at `vendor/bignumber.js` for the hosted demo and
inlined into `dafny-verify.html`.

> MIT Licence
>
> Copyright © `<2026>` `Michael Mclaughlin`
>
> Permission is hereby granted, free of charge, to any person
> obtaining a copy of this software and associated documentation
> files (the “Software”), to deal in the Software without
> restriction, including without limitation the rights to use,
> copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following
> conditions:
>
> The above copyright notice and this permission notice shall be
> included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND,
> EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
> OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
> HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
> WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
> FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
> OTHER DEALINGS IN THE SOFTWARE.

## coi-serviceworker

<https://github.com/gzuidhof/coi-serviceworker> — vendored verbatim at
`prototype/wwwroot/coi-serviceworker.js` to provide cross-origin isolation on
GitHub Pages, which cannot send COOP/COEP headers itself.

> coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT

## esbuild

<https://github.com/evanw/esbuild> — MIT, build-time dependency only; not
redistributed.

## .NET runtime

The published site contains the Microsoft .NET 8 browser-wasm runtime
(`_framework/`), MIT-licensed: <https://github.com/dotnet/runtime>.

## Dafny OnlineTutorial

The demo's Tutorial tab renders the Dafny OnlineTutorial
(`docs/OnlineTutorial` in <https://github.com/dafny-lang/dafny>, MIT — the
maintained successor of the tutorial formerly hosted on rise4fun.com),
baked at build time from the pinned checkout with per-example expected
outcomes from the accompanying `.expect` files.

## rise4fun sample programs

The demo's "rise4fun classics" examples are the historical Dafny sample
programs from Microsoft Research's rise4fun.com (discontinued), recovered
from the Internet Archive's Wayback Machine. They are teaching snippets by
the Dafny authors, reproduced with attribution comments; one syntactic
modernization (`function method` → `function`) is noted inline where
applied.

## Brotli decoder (inline artifact only)

The single-file artifact built by `tools/make-dafny-artifact.mjs` embeds the
JavaScript Brotli decoder from the `brotli` npm package
(<https://github.com/foliojs/brotli.js>, MIT, © Devon Govett), which itself
contains Google's reference Brotli decoder:

> Copyright 2013 Google Inc. All Rights Reserved.
>
> Licensed under the Apache License, Version 2.0 (the "License");
> you may not use this file except in compliance with the License.
> You may obtain a copy of the License at
>
> https://www.apache.org/licenses/LICENSE-2.0
>
> Unless required by applicable law or agreed to in writing, software
> distributed under the License is distributed on an "AS IS" BASIS,
> WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
> See the License for the specific language governing permissions and
> limitations under the License.

The artifact also embeds the single-threaded Z3 build from
<https://github.com/rupnikj/z3-inline> (Z3 itself is covered by the Z3
notice above).
