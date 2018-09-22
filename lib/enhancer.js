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

/*
* Let's Enhance example requests and returned data
*
* POST https://letsenhance.io/auth/login
* Params: { "email": "joe.average@domain.com", "password": "pa$$w0rd1" } // top caliber pass for joe ;)
* Response:
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE1MzY2MDY3MDAsImlhdCI6MTUzNjYwNTgwMCwibmJmIjoxNTM2NjA1ODAwLCJqdGkiOiI2YmVjOWVhMC1jZjk1LTRiNzQtYjVlZS0wMGY4MWU1NDExYzgiLCJpZGVudGl0eSI6MzY1MjM0LCJmcmVzaCI6ZmFsc2UsInR5cGUiOiJhY2Nlc3MifQ.yLLhKLNphMEyAXCBYwDa5JAx_NKt8eaCemdIWZeiYV8",
  "refresh_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE1MzkxOTc4MDAsImlhdCI6MTUzNjYwNTgwMCwibmJmIjoxNTM2NjA1ODAwLCJqdGkiOiIzMmM3MWY1My1iZWQ1LTRkNzctOTA1My1mNzU0OWZlNDcxMTUiLCJpZGVudGl0eSI6MzY1MjM0LCJ0eXBlIjoicmVmcmVzaCJ9.RE9x4R7jW12p4AW8onusKsvZJ2j61AePb5j6F2M33a0"
}
*
* POST https://letsenhance.io/auth/refresh
* Params: null
* Response:
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE1MzY2MDYwNjIsImlhdCI6MTUzNjYwNTE2MiwibmJmIjoxNTM2NjA1MTYyLCJqdGkiOiJhOWFjM2MzMS04OWFlLTRlMjktODNjZS1iMWQ0MDVkZTMzNDUiLCJpZGVudGl0eSI6MzY1MjM0LCJmcmVzaCI6ZmFsc2UsInR5cGUiOiJhY2Nlc3MifQ.zSltyIk9C2eSN0DZxPjOuZklF2cKIdl7yXSXu9U420U"
}
*
* POST https://letsenhance.io/api/images/upload
* Params:
-----------------------------125962971930900
Content-Disposition: form-data; name="files"; filename="my_image.png"
Content-Type: image/png
... PNG
* Response:
{
  "balance": 913,
  "images": [
    {
      "download_url": "https://le-imgstore.s3.amazonaws.com/1599445?response-content-type=image%2Fpng&response-content-disposition=attachment%3B%20filename%2A%3Dutf-8%27%27my_image-.png&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=zXrku%2BmnMskS%2BTS75EyVweKICDU%3D&Expires=1536256384",
      "eta": null,
      "height": 1200,
      "id": 1599445,
      "original_name": "my_image.png",
      "status": "processing",
      "thumb_url": "https://le-imgstore.s3.amazonaws.com/1599445/t396?response-content-type=image%2Fjpeg&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=%2F6lLJNiuHggKf%2FspWIDz1T%2FkgLA%3D&Expires=1536256384",
      "uploaded": "2018-09-06T16:52:45.570272+00:00",
      "url": "https://le-imgstore.s3.amazonaws.com/1599445?response-content-type=image%2Fpng&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=mDn4Z7TgofybSQ%2BOUqoIJdIM2eQ%3D&Expires=1536256384",
      "versions": {},
      "width": 800
    }
  ]
}
*
* POST https://letsenhance.io/api/images/process
* Params: [{"original_id":1599445,"mod":"boring Auto PNG"}]
* Response:
[
  {
    "eta": "2018-09-06T16:53:55.190505+00:00",
    "id": 1537830,
    "job_id": "24fe102a-6262-4f0b-a16f-3ce30a29b5f4",
    "mod": "boring Auto PNG",
    "original_id": 1599445
  }
]
*
* POST https://letsenhance.io/api/images/in-process
* Params: {"ids":[1599445]}
* Response:
[
  {
    "download_url": "https://le-imgstore.s3.amazonaws.com/1599445?response-content-type=image%2Fpng&response-content-disposition=attachment%3B%20filename%2A%3Dutf-8%27%27my_image-.png&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=zDNbFn09fO1F1Dchc6b96TCXgaw%3D&Expires=1536256421",
    "eta": null,
    "height": 1200,
    "id": 1599445,
    "original_name": "my_image.png",
    "status": "finished",
    "thumb_url": "https://le-imgstore.s3.amazonaws.com/1599445/t396?response-content-type=image%2Fjpeg&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=vPe1iW82jRKeWbwgthSZhJ2CjWM%3D&Expires=1536256421",
    "uploaded": "2018-09-06T16:52:45.570272+00:00",
    "url": "https://le-imgstore.s3.amazonaws.com/1599445?response-content-type=image%2Fpng&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=spnSexJrN3sfev2Aoh%2BfGfWWYEA%3D&Expires=1536256421",
    "versions": {
      "boring": {
        "download_url": "https://le-imgstore.s3.amazonaws.com/1599445/boring?response-content-type=image%2Fpng&response-content-disposition=attachment%3B%20filename%2A%3Dutf-8%27%27my_image-boring.png&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=RXFd8eLWzlGWI9laJV42AwUWw8g%3D&Expires=1536256421",
        "height": 4800,
        "thumb_url": "https://le-imgstore.s3.amazonaws.com/1599445/boring/t396?response-content-type=image%2Fjpeg&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=EPe%2Fg13akKQng5VTnsikoE4FrvY%3D&Expires=1536256421",
        "url": "https://le-imgstore.s3.amazonaws.com/1599445/boring?response-content-type=image%2Fpng&AWSAccessKeyId=AKIAIFU5PY2YVSAGMK3Q&Signature=ysE4ZfB%2Bzv9mQBzFYL9rhu6S0OA%3D&Expires=1536256421",
        "width": 3200
      }
    },
    "width": 800
  }
]
*/
