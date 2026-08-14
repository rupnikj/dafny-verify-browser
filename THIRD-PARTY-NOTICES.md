# Third-party notices

This repository builds and redistributes (in the published GitHub Pages site
and any local `prototype/dist` output) compiled artifacts of the following
projects. All of them are MIT-licensed; the notices below are reproduced as
the license requires. The 58-line `patches/dafny-browser-compat.patch` is a
derivative of Dafny source and is likewise covered by Dafny's notice.

---

## Dafny

<https://github.com/dafny-lang/dafny> — pinned at
`f3c2fedfb2b88272af5b64f5e45d803a3bc0043a` (4.11.1). Compiled to .NET
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
the `z3-solver` npm package, version 5.0.0. Redistributed as `z3-built.js` /
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
