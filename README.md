# letsenhance
Command line client for letsenhance.io - Enhance images in a directory

## Install
`npm i -g letsenhance`
> Or download one of the executables from the releases page

## Usage:

#### Command line
`letsenhance [options] email password /path/source /path/dest`


#### Node
```
const Enhancer = require('letsenhance');

async function enhance() {
const enhancer = new Enhancer(options);
  let err = await enhancer.login(email, password);
  if (err) {
    return console.log('Login failed.');
  }

  err = await enhancer.enhanceDir(sourcePath, destPath);
  if (err) {
    return console.log(`Error while processing: ${err}`);
  }

  console.log('Processing complete!');
}

enhance();
```

### Options:
**`--type`** string - `JPEG` (default) or `PNG`; PNG yields a larger file that maintains its quality across any subsequent alterations (jpeg does not);
**`--version`** string - `magic` (default, for photographs), `boring` (for everything else), `color-enhance`, `tone-enhance`;
**`--mode`** string - `Auto` (default); Auto is the only supported transformation mode at the moment;
**`--maxParallel`** number - 10 (default); how many files to process at a time; use a lower value if you encounter frequent issues;
**`--attempts`** number - 6 (default); how many times to re-attempt an operation after a 'soft' failure; the default value should suffice;
**`--progressInterval`** number - 15 (default); how many seconds to wait before checking a file's progress; use a greater value if an error message suggests it (e.g. 30 or higher);
**`--stopOnFirstFailedFile`** boolean - `true` (default) or `false`; stop the entire process on a 'hard' failure (used to prevent wasting available transformations);

#### Example with options:
`letsenhance --type PNG --version boring --maxParallel 8 --progressInterval 30 joe.average@domain.com joespassword /path/source /path/dest`

## Notes:
Options must be placed before the email string.
If the paths or password contain spaces, use quotes: '/path to a dir' or "/path to another dir".
Make sure there are only images in the source path directory; other files will cause errors and eventually halt the process. Hidden files starting with '.' are ignored.
Don't use an option without a value, it may lead to unexpected results.
