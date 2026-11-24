import { packager } from '@electron/packager'

const folders = await packager({
  dir: '.',
  name: 'DevShift',
  platform: 'win32',
  arch: 'x64',
  out: 'out',
  overwrite: true,
  icon: './assets/devshift.ico',
  asar: { unpack: '**/{native/**,runtime/**}' },
  ignore: path => !!path && !/^\/(?:package\.json$|LICENSE$|runtime(?:\/|$)|assets(?:\/|$)|dist(?:\/|$))/.test(path),
  win32metadata: {
    CompanyName: 'DevShift contributors',
    FileDescription: 'DevShift',
    ProductName: 'DevShift',
    OriginalFilename: 'DevShift.exe',
  },
})
console.log(folders.join('\n'))
