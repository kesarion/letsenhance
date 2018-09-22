const fs = require('fs');
const fse = require('fs-extra');
const child = require('child_process');
const request = require('request');
const mkdirp = require('mkdirp');
const path = require("path");

class Enhancer {
    constructor(options = {}) {
        this.authorization = {};
        this.options = Object.assign({
            maxParallel: 10,
            attempts: 6,
            progressInterval: 15,
            version: 'boring',
            mode: 'Auto',
            type: 'PNG',
            stopOnFirstFailedFile: true
        }, options);
    }

    async enhanceDir(dir, destDir) {
        if (!this.authorization.access_token || !this.authorization.refresh_token) {
            return `Missing access/refresh tokens. Login or set the tokens manually beforehand.`;
        }

        let err, files;
        try {
            files = await fse.readdir(dir);
        } catch (err) {
            return `Error reading directory '${dir}': ${err}`;
        }

        err = await makePath(destDir);
        if (err) {
            return `Could not access the destination directory '${destDir}': ${err}`;
        }

        console.log(`Enhancing images...`);
        files = files.filter(file => file[0] != '.');
        let promises = [];
        while (files.length) {
            for (let name of files.slice(0, this.options.maxParallel)) {
                promises.push(this.enhance(`${dir}${path.sep}${name}`, `${destDir}${path.sep}${name}`, name));
            }

            for (let promise of promises) {
                err = await promise;
                if (err) {
                    console.log(err);

                    if (this.options.stopOnFirstFailedFile) {
                        return `File processing failed. Stopping to preserve actions.`;
                    }
                }
            }

            files = files.slice(this.options.maxParallel);
        }

        return null;
    }

    async enhance(file, destFile, name) {
        let err, body, attempt;

        console.log('Uploading: ', name);
        for (attempt = 0; attempt < this.options.attempts; attempt++) {
            ({ err, body } = await this.upload(file, name, this.options.type == 'PNG' ? 'image/png' : 'image/jpeg'));

            if (!err) {
                break;
            }

            console.log(`Error uploading '${name}' (attempt ${attempt + 1}): ${err}`);
        }

        if (err) {
            return `Could not upload file: ${file}.\nError: ${err}`;
        } else if (!body || !body.images || !body.images.length) {
            return `[Upload] Unexpected body: ${JSON.stringify(body)}`;
        }

        const imageId = body.images[0].id;

        console.log('Processing: ', name);
        for (attempt = 0; attempt < this.options.attempts; attempt++) {
            ({ err, body } = await this.process(imageId, `${this.options.version} ${this.options.mode} ${this.options.type}`));

            if (!err) {
                break;
            }

            console.log(`Error processing '${name}' (attempt ${attempt + 1}): ${err}`);
        }

        if (err) {
            return `Could not process file: ${file}. Error: ${err}`;
        }

        const maxAttemptsProgress = this.options.attempts * 3;
        for (attempt = 0; attempt < maxAttemptsProgress; attempt++) {
            ({ err, body } = await this.inProcess(imageId));

            if (!err) {
                if (body && body[0] && body[0].status == 'finished') {
                    break;
                }

                console.log(`Status for '${name}': ${body && body[0] && body[0].status} (${attempt + 1})`);
            } else {
                console.log(`Error checking progress for '${name}' (attempt ${attempt + 1}): ${err}`);
            }

            await new Promise(resolve => setTimeout(resolve, this.options.progressInterval * 1000));
        }

        if (err) {
            return `Could not check file progress: ${file}.\nError: ${err}`;
        } else if (!body || !body[0] || body[0].status != 'finished') {
            return `Timeout before file processing finished. Last response body:\n\n${JSON.stringify(body)}\n\nIf the last status is still 'processing', consider using a longer options.progressCheckInterval.`;
        }

        console.log('Downloading: ', name);
        for (attempt = 0; attempt < this.options.attempts; attempt++) {
            (err = await this.download(body[0].versions[this.options.version].download_url, destFile));

            if (!err) {
                break;
            }

            console.log(`Error downloading '${name}' (attempt ${attempt + 1}): ${err}`);
        }

        if (err) {
            return `Could not download file: ${file}. Error: ${err}`;
        }

        return null;
    }

    async upload(file, name, type) {
        return await this.request({
            method: 'POST',
            url: 'https://letsenhance.io/api/images/upload',
            formOpt: { field: 'files', file: file, name: name, type: type },
            json: true
        });
    }

    async process(id, options) {
        return await this.request({
            method: 'POST',
            url: 'https://letsenhance.io/api/images/process',
            body: [{ original_id: id, mod: options }],
            json: true
        });
    }

    async inProcess(id) {
        return await this.request({
            method: 'POST',
            url: 'https://letsenhance.io/api/images/in-process',
            body: { ids: [ id ] },
            json: true
        });
    }

    async request(options) {
        let { err, res, body } = await req(Object.assign(options, { headers: { Authorization: `Bearer ${this.authorization.access_token}` } }));

        if (err) {
            return { err };
        }

        if (res.statusCode != 200) {
            if (res.statusCode != 401) {
                return `Unexpected response. Status code: ${res.statusCode}. Body: ${JSON.stringify(body)}`;
            }

            err = await this.refresh();

            if (err) {
                return { err };
            }
        }

        return { err, res, body };
    }

    async login(email, password) {
        let { err, res ,body } = await req({
            method: 'POST',
            url: 'https://letsenhance.io/auth/login',
            body: { email: email, password: password },
            json: true
        });

        if (err) {
            return err;
        }

        if (res.statusCode != 200) {
            return `Could not login. Status code: ${res.statusCode}. Body: ${JSON.stringify(body)}`;
        }

        if (!body || !body.access_token || !body.refresh_token) {
            return `[Login] Unexpected body: ${JSON.stringify(body)}`;
        }

        this.authorization = body;

        return null;
    }

    async refresh() {
        console.log('Refreshing access token.');
        let { err, res ,body } = await req({
            method: 'POST',
            url: 'https://letsenhance.io/auth/refresh',
            headers: { Authorization: `Bearer ${this.authorization.refresh_token}` },
            body: null,
            json: true
        });

        if (err) {
            return err;
        }

        if (res.statusCode != 200) {
            return `Could not refresh authorization. Status code: ${res.statusCode}. Body: ${JSON.stringify(body)}`;
        }

        if (!body || !body.access_token) {
            return `[Refresh] Unexpected body: ${JSON.stringify(body)}`;
        }

        this.authorization.access_token = body.access_token;

        return null;
    }

    async download(url, file) {
        const { err, body } = await req({ url: url, encoding: null, gzip: true, timeout: 60000 });
        if (err) {
            return `Request error [${err.code} | ${err.connect === true ? 'Connection' : 'Read'}] ${url}`;
        }

        try {
            await fse.writeFile(file, body);
        } catch (err) {
            await execute('rm', ['-rf', file]); // clean up

            return `Error writing file '${file}': ${err}`;
        }

        try {
            await fse.access(file);
        } catch (err) {
            return err;
        }

        return null;
    }
}

function execute(command, args) {
    return new Promise((resolve, reject) => {
        let cmd = child.spawn(command, args);

        cmd
            .on('error', err => {
                console.log(err);
                resolve();
            })
            .on('close', resolve);

        cmd.stdout.on('data', res => resolve(res.toString()));
        cmd.stderr.on('data', err => {
            console.log(err.toString());
            resolve();
        });
    });
}

async function req(options) {
    return await new Promise(resolve => {
        const myRequest = request(options, (err, res, body) => resolve({ err, res, body }));
        if (options.formOpt) {
            const form = myRequest.form();
            form.append(options.formOpt.field, fs.createReadStream(options.formOpt.file), { filename: options.formOpt.name, contentType: options.formOpt.type });
        }
    });
}

function makePath (path) {
    return new Promise(resolve => mkdirp(path, resolve));
}

module.exports = Enhancer;
