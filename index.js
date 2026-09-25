const axios = require('axios');
const cheerio = require('cheerio');
const core = require('@actions/core');

const version = process.argv[2]; // Версия OpenWrt / имя релиза
const filterTargetsStr = process.argv[3] || ''; // Фильтр по targets
const filterSubtargetsStr = process.argv[4] || ''; // Фильтр по subtargets

// Преобразуем строки с запятыми в массивы
const filterTargets = filterTargetsStr
  ? filterTargetsStr.split(',').map(t => t.trim()).filter(t => t)
  : [];

const filterSubtargets = filterSubtargetsStr
  ? filterSubtargetsStr.split(',').map(s => s.trim()).filter(s => s)
  : [];

const excludedBuilds = [
  {
    target: 'microchipsw',
    subtarget: 'lan969x',
    reason: 'OpenWrt SDK fails while packaging kmod-crypto-xxhash: xxhash.ko is built into the kernel for this specialized target',
  },
];

if (!version) {
  core.setFailed('Version argument is required');
  process.exit(1);
}

// Используем snapshots вместо releases.
// Версия OpenWrt больше не используется для формирования URL.
const url = 'https://downloads.openwrt.org/snapshots/targets/';

async function fetchHTML(url) {
  try {
    const { data } = await axios.get(url);
    return cheerio.load(data);
  } catch (error) {
    console.error(`Error fetching HTML for ${url}: ${error}`);
    throw error;
  }
}

async function getTargets() {
  const $ = await fetchHTML(url);
  const targets = [];

  $('table tr td.n a').each((index, element) => {
    const name = $(element).attr('href');

    if (name && name.endsWith('/')) {
      targets.push(name.slice(0, -1));
    }
  });

  return targets;
}

async function getSubtargets(target) {
  const $ = await fetchHTML(`${url}${target}/`);
  const subtargets = [];

  $('table tr td.n a').each((index, element) => {
    const name = $(element).attr('href');

    if (name && name.endsWith('/')) {
      subtargets.push(name.slice(0, -1));
    }
  });

  return subtargets;
}

async function getDetails(target, subtarget) {
  // pkgarch from packages/index.json
  // Работает как для apk-based, так и для ipk-based OpenWrt
  const indexUrl = `${url}${target}/${subtarget}/packages/index.json`;

  let pkgarch = '';

  try {
    const { data } = await axios.get(indexUrl, {
      responseType: 'json',
    });

    pkgarch = data.architecture || '';
  } catch (e) {
    // Некоторые targets могут не иметь index.json
    // В этом случае оставляем pkgarch пустым
    console.warn(`Could not get package architecture from ${indexUrl}`);
  }

  // vermagic из директории kmods
  // Это надёжнее, чем пытаться извлекать его из имени kernel package
  const kmodsUrl = `${url}${target}/${subtarget}/kmods/`;

  let vermagic = '';

  try {
    const $ = await fetchHTML(kmodsUrl);

    $('table tr td.n a').each((_, el) => {
      const name = $(el).attr('href');

      if (name && name.endsWith('/')) {
        vermagic = name.slice(0, -1);
        return false; // break
      }
    });
  } catch (e) {
    console.warn(`Could not get vermagic from ${kmodsUrl}`);
  }

  return {
    vermagic,
    pkgarch,
  };
}

async function main() {
  try {
    console.log(`Using OpenWrt snapshots`);
    console.log(`Base URL: ${url}`);
    console.log(`Release/tag version: ${version}`);

    const targets = await getTargets();

    console.log(`Found ${targets.length} targets`);

    const jobConfig = [];

    for (const target of targets) {
      // Если указан фильтр targets,
      // пропускаем target, которого нет в списке
      if (
        filterTargets.length > 0 &&
        !filterTargets.includes(target)
      ) {
        continue;
      }

      const subtargets = await getSubtargets(target);

      for (const subtarget of subtargets) {
        // Если указан фильтр subtargets,
        // пропускаем subtarget, которого нет в списке
        if (
          filterSubtargets.length > 0 &&
          !filterSubtargets.includes(subtarget)
        ) {
          continue;
        }

        // Автоматический запуск:
        // собираем все targets/subtargets
        const isAutomatic =
          filterTargets.length === 0 &&
          filterSubtargets.length === 0;

        // Ручной запуск:
        // target и subtarget должны быть указаны
        const isManualMatch =
          filterTargets.length > 0 &&
          filterSubtargets.length > 0 &&
          filterTargets.includes(target) &&
          filterSubtargets.includes(subtarget);

        if (!isAutomatic && !isManualMatch) {
          continue;
        }

        // Исключённые сборки
        const excludedBuild = excludedBuilds.find(
          item =>
            item.target === target &&
            item.subtarget === subtarget
        );

        if (excludedBuild) {
          core.warning(
            `Skipping ${target}/${subtarget}: ${excludedBuild.reason}`
          );

          continue;
        }

        console.log(
          `Processing ${target}/${subtarget}...`
        );

        const {
          vermagic,
          pkgarch,
        } = await getDetails(target, subtarget);

        jobConfig.push({
          // Сохраняем version для GitHub Release,
          // несмотря на то что SDK берётся из snapshots
          tag: version,

          target,
          subtarget,
          vermagic,
          pkgarch,
        });
      }
    }

    if (jobConfig.length === 0) {
      core.setFailed(
        'No build configurations found'
      );

      return;
    }

    console.log(
      `Generated ${jobConfig.length} build configurations`
    );

    core.setOutput(
      'job-config',
      JSON.stringify(jobConfig)
    );
  } catch (error) {
    console.error(error);

    core.setFailed(
      error instanceof Error
        ? error.message
        : String(error)
    );
  }
}

main();
