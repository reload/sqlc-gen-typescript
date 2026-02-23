.PHONY: clean generate

generate: examples/plugin.wasm examples/sqlc.dev.yaml
	cd examples && sqlc -f sqlc.dev.yaml generate

# https://github.com/bytecodealliance/javy/releases/tag/v7.0.1
examples/plugin.wasm: out.js bin/javy
	./bin/javy build out.js --codegen source=omitted -o examples/plugin.wasm

out.js: src/app.ts $(wildcard src/drivers/*.ts) src/gen/plugin/codegen_pb.ts node_modules
	npx tsc --noEmit
	npx esbuild --bundle src/app.ts --tree-shaking=true --format=esm --target=es2020 --outfile=out.js

src/gen/plugin/codegen_pb.ts: buf.gen.yaml
	npx @bufbuild/buf generate --template buf.gen.yaml buf.build/sqlc/sqlc --path plugin/

node_modules: package.json package-lock.json
	npm install

bin/javy:
	wget https://github.com/bytecodealliance/javy/releases/download/v7.0.1/javy-x86_64-linux-v7.0.1.gz
	gunzip --force javy-x86_64-linux-v7.0.1.gz
	install -Dpv javy-x86_64-linux-v7.0.1 bin/javy

clean:
	$(RM) -r out.js
	$(RM) -r examples/plugin.wasm
	$(RM) -r node_modules
	$(RM) -r bin/javy javy-x86_64-linux-v7.0.1 javy-x86_64-linux-v7.0.1.gz
