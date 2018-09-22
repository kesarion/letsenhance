#!/usr/bin/env node

const Enhancer = require('../lib/enhancer');

const email = process.argv[process.argv.length - 4];
const password = process.argv[process.argv.length - 3];
const sourcePath = process.argv[process.argv.length - 2];
const destPath = process.argv[process.argv.length - 1];
const help = process.argv.includes('--help') || process.argv.includes('help');

let options = {};

process.argv.forEach((arg, i) => {
    const value = process.argv[i + 1];
    switch (arg) {
        case '--type':
            options.type = value == 'PNG' ? 'PNG' : 'JPEG';
            break;
        case '--version':
            options.version = ['magic', 'boring', 'color-enhance', 'tone-enhance'].includes(value) ? value : 'magic';
            break;
        case '--mode':
            options.mode = value;
            break;
        case '--maxParallel':
            options.maxParallel = isNaN(value) ? 10 : (+value);
            break;
        case '--attempts':
            options.attempts = isNaN(value) ? 6 : (+value);
            break;
        case '--progressInterval':
            options.progressInterval = isNaN(value) ? 15 : (+value);
            break;
        case '--stopOnFirstFailedFile':
            options.stopOnFirstFailedFile = value == 'true';
            break;
    }
});

if (help) {
    return console.log(`
    Enhance images in a directory using letsenhance.io
    
    Usage:
    letsenhance [options] email password /path/source /path/dest
    
    Options:
    --type string - JPEG (default) or PNG; PNG yields a larger file that maintains its quality across any subsequent alterations (jpeg does not);
    --version string - magic (default, for photographs), boring (for everything else), color-enhance, tone-enhance; 
    --mode string - Auto (default); there is no other supported transformation mode at the moment;
    --maxParallel number - 10 (default); how many files to process at a time; use a lower value if you encounter frequent issues;
    --attempts number - 6 (default); how many times to re-attempt an operation after a 'soft' failure; the default value should suffice;
    --progressInterval number - 15 (default); how many seconds to wait before checking a file's progress; use a greater value if an error message suggests it (e.g. 30 or higher);
    --stopOnFirstFailedFile boolean - true (default) or false; stop the entire process on a 'hard' failure (used to prevent wasting available transformations);
    
    Example with options:
    letsenhance --type PNG --version boring --maxParallel 8 --progressInterval 30 joe.average@domain.com joespassword /path/source /path/dest
    
    Notes:
    The options must be placed before the email string.
    If the paths or password contain spaces, use quotes: '/path to a dir' or "/path to another dir".
    Make sure there are only images in the source path directory; other files will cause errors and eventually halt the process. Hidden files starting with '.' are ignored.
    Don't use an option without a value, it may lead to unexpected results.
    `);
}

if (!~email.indexOf('@')) {
    return console.log('Please enter a valid email and/or make sure the argument order is correct:\nletsenhance [options] email password /path/source /path/dest');
}

run();

async function run() {
    const enhancer = new Enhancer(options);

    let err = await enhancer.login(email, password);

    if (err) {
        return console.log('Login failed. Verify your email, password and internet connection.\nIf you can login on letsenhance.io, but not here, please create an issue at https://github.com/kesarion/letsenhance');
    }

    err = await enhancer.enhanceDir(sourcePath, destPath);

    if (err) {
        return console.log(`Error while processing: ${err}`);
    }

    console.log('Processing complete!');
}
