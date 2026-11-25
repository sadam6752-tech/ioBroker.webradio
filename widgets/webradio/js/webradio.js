/*
    ioBroker.webradio — widget set for vis (vis 1, EJS/jQuery)

    The widget "Radio" only reads and writes the states of the adapter:
      <instance>.info.stations, <instance>.info.targets (JSON lists),
      <instance>.targets.<player>.station / playing / title / volume / stop.
    Nothing else is needed on the server: writing `station` plays the station.

    MIT License, see LICENSE of ioBroker.webradio
*/
/* global vis, systemDictionary, systemLang, $ */
'use strict';

(function () {
    // ---------- helpers without the browser (unit tests load this file in Node) ----------

    const INSTANCE = /^webradio\.\d+$/;
    const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

    /**
     * @param {unknown} value - Attribute value
     * @returns {string} Valid instance id, default webradio.0
     */
    function instanceOf(value) {
        const v = String(value || '').trim();
        return INSTANCE.test(v) ? v : 'webradio.0';
    }

    /**
     * @param {unknown} value - State value (JSON text)
     * @returns {any[]} Parsed list, [] when it is no list
     */
    function parseList(value) {
        if (Array.isArray(value)) {
            return value;
        }
        try {
            const list = JSON.parse(String(value || '[]'));
            return Array.isArray(list) ? list.filter(x => x && typeof x.id === 'string') : [];
        } catch {
            return [];
        }
    }

    /**
     * The player to show: the fixed one of the widget (id or name), else the one picked last, else the first.
     *
     * @param {{id: string, name: string}[]} targets - Players
     * @param {string} fixed - Attribute "player"
     * @param {string} remembered - Player picked last on this device
     * @returns {string} Player id or ''
     */
    function pickTarget(targets, fixed, remembered) {
        const want = String(fixed || '')
            .trim()
            .toLowerCase();
        if (want) {
            const hit = targets.find(t => t.id.toLowerCase() === want || String(t.name).toLowerCase() === want);
            return hit ? hit.id : '';
        }
        if (remembered && targets.some(t => t.id === remembered)) {
            return remembered;
        }
        return targets.length ? targets[0].id : '';
    }

    /**
     * Logo of a station for the browser: the cached file through the web adapter (same origin as vis, so https
     * works too), else the logo URL of the adapter.
     *
     * @param {{file?: string, logo?: string}} station - Entry of info.stations
     * @returns {string[]} Candidates in order, the next one is tried when one fails to load
     */
    function logoSources(station) {
        const out = [];
        if (station && station.file && /^webradio\.\d+\.storage\/logos\/[\w.-]+$/.test(station.file)) {
            out.push(`../${station.file}`);
        }
        if (station && station.logo && /^https?:\/\//i.test(station.logo)) {
            out.push(station.logo);
        }
        return out;
    }

    /**
     * @param {unknown} text - Text
     * @returns {string} Text safe inside HTML and attributes
     */
    function esc(text) {
        return String(text === undefined || text === null ? '' : text).replace(
            /[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c,
        );
    }

    /**
     * @param {unknown} value - Attribute value
     * @param {number} def - Default
     * @returns {number} Columns, 1–12
     */
    function columnsOf(value, def) {
        const n = parseInt(String(value), 10);
        return Number.isFinite(n) ? Math.min(12, Math.max(1, n)) : def;
    }

    /**
     * @param {unknown} value - Attribute value (checkbox: true, 'true', or undefined for the default)
     * @param {boolean} def - Default
     * @returns {boolean} Flag
     */
    function flag(value, def) {
        if (value === undefined || value === null || value === '') {
            return def;
        }
        return value === true || value === 'true';
    }

    /** Weekday names the adapter understands in alarmDays (Monday first), besides 1 … 7 */
    const DAY_KEYS = [
        ['mo', 'mon', 'пн'],
        ['tu', 'tue', 'di', 'вт'],
        ['we', 'wed', 'mi', 'ср'],
        ['th', 'thu', 'do', 'чт'],
        ['fr', 'fri', 'пт'],
        ['sa', 'sat', 'сб'],
        ['su', 'sun', 'so', 'вс'],
    ];

    /**
     * The weekdays of an alarmDays value as ticks (Monday first); '' = every day = none ticked.
     *
     * @param {unknown} value - "1-5", "1,3,5", "mo,we", ''
     * @returns {boolean[]} Seven ticks
     */
    function daysToTicks(value) {
        const ticks = [false, false, false, false, false, false, false];
        const text = String(value == null ? '' : value)
            .trim()
            .toLowerCase();
        const day = t => {
            if (/^[1-7]$/.test(t)) {
                return Number(t);
            }
            const i = DAY_KEYS.findIndex(names => names.includes(t));
            return i >= 0 ? i + 1 : 0;
        };
        for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
            const range = part.split('-');
            const a = day(range[0]);
            const b = range.length === 2 ? day(range[1]) : a;
            if (!a || !b) {
                continue;
            }
            for (let d = a; ; d = (d % 7) + 1) {
                ticks[d - 1] = true;
                if (d === b) {
                    break;
                }
            }
        }
        return ticks.every(Boolean) ? ticks.map(() => false) : ticks;
    }

    /**
     * @param {boolean[]} ticks - Seven ticks, Monday first
     * @returns {string} alarmDays ('' = every day)
     */
    function ticksToDays(ticks) {
        const on = ticks.map((t, i) => (t ? i + 1 : 0)).filter(Boolean);
        return on.length === 0 || on.length === 7 ? '' : on.join(',');
    }

    /** Steps of the sleep button, in minutes; after the last one it turns off */
    const SLEEP_STEPS = [15, 30, 60, 90];

    /**
     * @param {unknown} current - Value of the sleep state
     * @returns {number} The next step, 0 = off
     */
    function nextSleep(current) {
        const now = Number(current) || 0;
        return SLEEP_STEPS.find(m => m > now) || 0;
    }

    /**
     * @param {unknown} value - Volume state (0–100)
     * @returns {number} Volume for the slider
     */
    function volumeOf(value) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : 0;
    }

    /** Words of the widget and the names of its attributes in the editor */
    const WORDS = {
        radioInstance: [
            'Adapter instance',
            'Adapterinstanz',
            'Экземпляр адаптера',
            'Instância do adaptador',
            'Adapterinstantie',
            "Instance de l'adaptateur",
            "Istanza dell'adattatore",
            'Instancia del adaptador',
            'Instancja adaptera',
            'Екземпляр адаптера',
            '适配器实例',
        ],
        radioPlayer: [
            'Fixed player (id or name, empty = choice)',
            'Festes Abspielgerät (ID oder Name, leer = Auswahl)',
            'Фиксированный плеер (id или имя, пусто = выбор)',
            'Leitor fixo (id ou nome, vazio = escolha)',
            'Vaste speler (id of naam, leeg = keuze)',
            'Lecteur fixe (id ou nom, vide = choix)',
            'Lettore fisso (id o nome, vuoto = scelta)',
            'Reproductor fijo (id o nombre, vacío = elegir)',
            'Stały odtwarzacz (id lub nazwa, puste = wybór)',
            'Фіксований плеєр (id або назва, порожньо = вибір)',
            '固定播放器（ID 或名称，留空 = 可选择）',
        ],
        radioColumns: [
            'Columns',
            'Spalten',
            'Столбцы',
            'Colunas',
            'Kolommen',
            'Colonnes',
            'Colonne',
            'Columnas',
            'Kolumny',
            'Стовпці',
            '列数',
        ],
        radioShowTitle: [
            'Show now playing',
            'Aktuellen Titel zeigen',
            'Показывать текущий трек',
            'Mostrar o que está a tocar',
            'Huidige titel tonen',
            'Afficher le titre en cours',
            'Mostra il titolo in riproduzione',
            'Mostrar lo que suena',
            'Pokaż aktualny utwór',
            'Показувати поточний трек',
            '显示正在播放',
        ],
        radioShowVolume: [
            'Show volume',
            'Lautstärke zeigen',
            'Показывать громкость',
            'Mostrar volume',
            'Volume tonen',
            'Afficher le volume',
            'Mostra il volume',
            'Mostrar volumen',
            'Pokaż głośność',
            'Показувати гучність',
            '显示音量',
        ],
        radioShowNames: [
            'Station names under the logos',
            'Sendernamen unter den Logos',
            'Названия станций под логотипами',
            'Nomes das estações sob os logótipos',
            'Zendernamen onder de logo’s',
            'Noms des stations sous les logos',
            'Nomi delle stazioni sotto i loghi',
            'Nombres de las emisoras bajo los logotipos',
            'Nazwy stacji pod logo',
            'Назви станцій під логотипами',
            '在标志下显示电台名称',
        ],
        group_radioColors: [
            'Colours',
            'Farben',
            'Цвета',
            'Cores',
            'Kleuren',
            'Couleurs',
            'Colori',
            'Colores',
            'Kolory',
            'Кольори',
            '颜色',
        ],
        radioTheme: ['Theme', 'Farbschema', 'Тема', 'Tema', 'Thema', 'Thème', 'Tema', 'Tema', 'Motyw', 'Тема', '主题'],
        radioBackground: [
            'Background',
            'Hintergrund',
            'Фон',
            'Fundo',
            'Achtergrond',
            'Arrière-plan',
            'Sfondo',
            'Fondo',
            'Tło',
            'Тло',
            '背景',
        ],
        radioText: [
            'Text colour',
            'Textfarbe',
            'Цвет текста',
            'Cor do texto',
            'Tekstkleur',
            'Couleur du texte',
            'Colore del testo',
            'Color del texto',
            'Kolor tekstu',
            'Колір тексту',
            '文字颜色',
        ],
        radioAccent: [
            'Accent (playing station, slider)',
            'Akzent (laufender Sender, Regler)',
            'Акцент (играющая станция, ползунок)',
            'Destaque (estação a tocar, controlo)',
            'Accent (spelende zender, schuifregelaar)',
            'Accent (station en cours, curseur)',
            'Accento (stazione in riproduzione, cursore)',
            'Acento (emisora que suena, control)',
            'Akcent (grająca stacja, suwak)',
            'Акцент (станція, що грає, повзунок)',
            '强调色（正在播放的电台、滑块）',
        ],
        radioTile: [
            'Tile background',
            'Kachelhintergrund',
            'Фон плиток',
            'Fundo dos mosaicos',
            'Achtergrond van de tegels',
            'Fond des tuiles',
            'Sfondo dei riquadri',
            'Fondo de los mosaicos',
            'Tło kafelków',
            'Тло плиток',
            '磁贴背景',
        ],
        wrPlayer: [
            'Player',
            'Abspielgerät',
            'Плеер',
            'Leitor',
            'Speler',
            'Lecteur',
            'Lettore',
            'Reproductor',
            'Odtwarzacz',
            'Плеєр',
            '播放器',
        ],
        wrStop: [
            'Stop',
            'Stopp',
            'Стоп',
            'Parar',
            'Stoppen',
            'Arrêter',
            'Ferma',
            'Detener',
            'Zatrzymaj',
            'Стоп',
            '停止',
        ],
        wrPrev: [
            'Previous station',
            'Vorheriger Sender',
            'Предыдущая станция',
            'Estação anterior',
            'Vorige zender',
            'Station précédente',
            'Stazione precedente',
            'Emisora anterior',
            'Poprzednia stacja',
            'Попередня станція',
            '上一个电台',
        ],
        wrResume: [
            'Play the last station',
            'Letzten Sender abspielen',
            'Включить последнюю станцию',
            'Tocar a última estação',
            'Laatste zender afspelen',
            'Écouter la dernière station',
            "Riproduci l'ultima stazione",
            'Reproducir la última emisora',
            'Odtwórz ostatnią stację',
            'Увімкнути останню станцію',
            '播放上一个电台',
        ],
        wrNext: [
            'Next station',
            'Nächster Sender',
            'Следующая станция',
            'Próxima estação',
            'Volgende zender',
            'Station suivante',
            'Stazione successiva',
            'Siguiente emisora',
            'Następna stacja',
            'Наступна станція',
            '下一个电台',
        ],
        wrSleep: [
            'Sleep timer: tap for 15, 30, 60, 90 min, off',
            'Schlaftimer: tippen für 15, 30, 60, 90 min, aus',
            'Таймер сна: нажмите для 15, 30, 60, 90 мин, выкл.',
            'Temporizador: toque para 15, 30, 60, 90 min, desligar',
            'Slaaptimer: tik voor 15, 30, 60, 90 min, uit',
            'Minuterie : touchez pour 15, 30, 60, 90 min, arrêt',
            'Timer: tocca per 15, 30, 60, 90 min, spento',
            'Temporizador: toque para 15, 30, 60, 90 min, apagado',
            'Wyłącznik: dotknij dla 15, 30, 60, 90 min, wył.',
            'Таймер сну: натисніть для 15, 30, 60, 90 хв, вимк.',
            '睡眠定时器：点击设为 15、30、60、90 分钟或关闭',
        ],
        wrVolume: [
            'Volume',
            'Lautstärke',
            'Громкость',
            'Volume',
            'Volume',
            'Volume',
            'Volume',
            'Volumen',
            'Głośność',
            'Гучність',
            '音量',
        ],
        wrNothing: [
            'Nothing plays',
            'Es läuft nichts',
            'Ничего не играет',
            'Nada a tocar',
            'Er speelt niets',
            'Rien ne joue',
            'Nessuna riproduzione',
            'No suena nada',
            'Nic nie gra',
            'Нічого не грає',
            '未在播放',
        ],
        wrNoStations: [
            'No favourite stations — add them in the adapter settings',
            'Keine Lieblingssender – in den Adaptereinstellungen hinzufügen',
            'Нет избранных станций — добавьте их в настройках адаптера',
            'Sem estações favoritas — adicione-as nas definições do adaptador',
            'Geen favoriete zenders — voeg ze toe in de adapterinstellingen',
            "Aucune station favorite — ajoutez-en dans les réglages de l'adaptateur",
            "Nessuna stazione preferita — aggiungile nelle impostazioni dell'adattatore",
            'No hay emisoras favoritas — añádalas en la configuración del adaptador',
            'Brak ulubionych stacji — dodaj je w ustawieniach adaptera',
            'Немає улюблених станцій — додайте їх у налаштуваннях адаптера',
            '没有收藏的电台 — 请在适配器设置中添加',
        ],
        wrAlarm: [
            'Wake-up radio',
            'Radiowecker',
            'Радиобудильник',
            'Rádio despertador',
            'Wekkerradio',
            'Radio-réveil',
            'Radiosveglia',
            'Radio despertador',
            'Radiobudzik',
            'Радіобудильник',
            '收音机闹钟',
        ],
        wrAlarmSave: [
            'Save',
            'Speichern',
            'Сохранить',
            'Guardar',
            'Opslaan',
            'Enregistrer',
            'Salva',
            'Guardar',
            'Zapisz',
            'Зберегти',
            '保存',
        ],
        wrAlarmOff: [
            'Switch off',
            'Ausschalten',
            'Выключить',
            'Desligar',
            'Uitschakelen',
            'Désactiver',
            'Disattiva',
            'Desactivar',
            'Wyłącz',
            'Вимкнути',
            '关闭',
        ],
        wrAlarmLast: [
            'Last station',
            'Letzter Sender',
            'Последняя станция',
            'Última estação',
            'Laatste zender',
            'Dernière station',
            'Ultima stazione',
            'Última emisora',
            'Ostatnia stacja',
            'Остання станція',
            '上一个电台',
        ],
        wrAlarmNext: [
            'Next',
            'Nächstes',
            'Следующий',
            'Próximo',
            'Volgende',
            'Prochain',
            'Prossima',
            'Próximo',
            'Następne',
            'Наступний',
            '下次',
        ],
        wrAlarmEvery: [
            'every day',
            'täglich',
            'каждый день',
            'todos os dias',
            'elke dag',
            'tous les jours',
            'ogni giorno',
            'todos los días',
            'codziennie',
            'щодня',
            '每天',
        ],
        wrDays: [
            'Mo,Tu,We,Th,Fr,Sa,Su',
            'Mo,Di,Mi,Do,Fr,Sa,So',
            'Пн,Вт,Ср,Чт,Пт,Сб,Вс',
            'Seg,Ter,Qua,Qui,Sex,Sáb,Dom',
            'Ma,Di,Wo,Do,Vr,Za,Zo',
            'Lu,Ma,Me,Je,Ve,Sa,Di',
            'Lu,Ma,Me,Gi,Ve,Sa,Do',
            'Lu,Ma,Mi,Ju,Vi,Sá,Do',
            'Pn,Wt,Śr,Cz,Pt,So,Nd',
            'Пн,Вт,Ср,Чт,Пт,Сб,Нд',
            '一,二,三,四,五,六,日',
        ],
        wrNoPlayer: [
            'Player not found',
            'Abspielgerät nicht gefunden',
            'Плеер не найден',
            'Leitor não encontrado',
            'Speler niet gevonden',
            'Lecteur introuvable',
            'Lettore non trovato',
            'Reproductor no encontrado',
            'Nie znaleziono odtwarzacza',
            'Плеєр не знайдено',
            '未找到播放器',
        ],
    };

    /**
     * @returns {Record<string, Record<string, string>>} WORDS in the shape of systemDictionary
     */
    function dictionary() {
        /** @type {Record<string, Record<string, string>>} */
        const out = {};
        for (const key of Object.keys(WORDS)) {
            out[key] = {};
            LANGS.forEach((lang, i) => (out[key][lang] = WORDS[key][i]));
        }
        return out;
    }

    const helpers = {
        instanceOf,
        parseList,
        pickTarget,
        logoSources,
        esc,
        columnsOf,
        flag,
        volumeOf,
        nextSleep,
        daysToTicks,
        ticksToDays,
        dictionary,
        WORDS,
        LANGS,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = helpers;
    }
    if (typeof window === 'undefined' || typeof vis === 'undefined') {
        return;
    }

    // ---------- vis ----------

    if (typeof systemDictionary !== 'undefined') {
        $.extend(true, systemDictionary, dictionary());
    }

    /**
     * @returns {string} Language of vis (one of LANGS)
     */
    function visLang() {
        return typeof systemLang !== 'undefined' && LANGS.includes(systemLang) ? systemLang : 'en';
    }

    /**
     * @param {string} key - Word
     * @returns {string} Word in the language of vis
     */
    function word(key) {
        const lang = visLang();
        const w = WORDS[key];
        return w ? w[LANGS.indexOf(lang)] || w[0] : key;
    }

    /**
     * @param {string} id - State id
     * @returns {unknown} Value as vis knows it (runtime: can.Map, editor: plain object)
     */
    function valueOf(id) {
        const s = vis.states;
        if (!s) {
            return undefined;
        }
        return typeof s.attr === 'function' ? s.attr(`${id}.val`) : s[`${id}.val`];
    }

    /**
     * Reads states vis does not know yet (they are in no widget attribute) and subscribes them.
     *
     * @param {string[]} ids - State ids
     * @param {() => void} done - Called when the values are there
     */
    function load(ids, done) {
        const missing = ids.filter(id => valueOf(id) === undefined);
        if (!missing.length || !vis.conn || typeof vis.conn.getStates !== 'function') {
            done();
            return;
        }
        vis.conn.getStates(missing, (err, data) => {
            if (data) {
                vis.updateStates(data);
            }
            if (!vis.editMode) {
                vis.conn.subscribe(missing);
            }
            done();
        });
    }

    /**
     * Remembers the player picked on this device (localStorage may be off: then nothing is remembered).
     */
    const memory = {
        get(wid) {
            try {
                return window.localStorage.getItem(`webradio.widget.${wid}`) || '';
            } catch {
                return '';
            }
        },
        set(wid, id) {
            try {
                window.localStorage.setItem(`webradio.widget.${wid}`, id);
            } catch {
                // not remembered
            }
        },
    };

    vis.binds.webradio = {
        helpers,

        /**
         * Draws the widget "Radio" and follows the states.
         *
         * @param {string} wid - Widget id
         * @param {any} data - Widget attributes
         */
        radio(wid, data) {
            const $div = $(`#${wid}`);
            if (!$div.length) {
                setTimeout(() => vis.binds.webradio.radio(wid, data), 100);
                return;
            }
            const inst = instanceOf(data.attr('radioInstance'));
            const fixed = String(data.attr('radioPlayer') || '').trim();
            const opts = {
                columns: columnsOf(data.attr('radioColumns'), 4),
                showTitle: flag(data.attr('radioShowTitle'), true),
                showVolume: flag(data.attr('radioShowVolume'), true),
                showNames: flag(data.attr('radioShowNames'), true),
            };
            const theme = ['light', 'dark', 'auto'].includes(data.attr('radioTheme'))
                ? data.attr('radioTheme')
                : 'dark';
            const vars = [
                ['--wr-bg', data.attr('radioBackground')],
                ['--wr-text', data.attr('radioText')],
                ['--wr-accent', data.attr('radioAccent')],
                ['--wr-tile', data.attr('radioTile')],
            ]
                .filter(v => v[1])
                .map(v => `${v[0]}:${esc(v[1])}`)
                .join(';');

            $div.addClass(`wr-radio wr-theme-${theme}`);
            $div.find('.wr-root').remove();
            $div.append(
                `<div class="wr-root" style="${vars}">` +
                    '<div class="wr-head">' +
                    `<select class="wr-player" title="${esc(word('wrPlayer'))}"></select>` +
                    '<span class="wr-player-name"></span>' +
                    `<button type="button" class="wr-btn wr-prev" title="${esc(word('wrPrev'))}">&#9198;</button>` +
                    `<button type="button" class="wr-btn wr-resume" title="${esc(word('wrResume'))}">&#9654;</button>` +
                    `<button type="button" class="wr-btn wr-next" title="${esc(word('wrNext'))}">&#9197;</button>` +
                    `<button type="button" class="wr-stop" title="${esc(word('wrStop'))}">&#9632;</button>` +
                    `<button type="button" class="wr-btn wr-sleep" title="${esc(word('wrSleep'))}">&#9790;<span class="wr-sleep-left"></span></button>` +
                    `<button type="button" class="wr-btn wr-alarm" title="${esc(word('wrAlarm'))}">&#9200;<span class="wr-alarm-time"></span></button>` +
                    '</div>' +
                    '<div class="wr-alarm-panel" style="display:none">' +
                    `<div class="wr-alarm-head"><span>${esc(word('wrAlarm'))}</span><button type="button" class="wr-btn wr-alarm-close">&#10005;</button></div>` +
                    '<input type="time" class="wr-alarm-input">' +
                    `<div class="wr-alarm-days">${word('wrDays')
                        .split(',')
                        .map((d, i) => `<button type="button" class="wr-day" data-day="${i}">${esc(d)}</button>`)
                        .join('')}</div>` +
                    '<select class="wr-alarm-station"></select>' +
                    '<div class="wr-alarm-next"></div>' +
                    '<div class="wr-alarm-buttons">' +
                    `<button type="button" class="wr-btn wr-alarm-off">${esc(word('wrAlarmOff'))}</button>` +
                    `<button type="button" class="wr-btn wr-alarm-save">${esc(word('wrAlarmSave'))}</button>` +
                    '</div>' +
                    '</div>' +
                    '<div class="wr-now">' +
                    '<div class="wr-now-logo"></div>' +
                    '<div class="wr-now-text"><div class="wr-now-station"></div><div class="wr-now-title"></div></div>' +
                    '</div>' +
                    '<div class="wr-volume">' +
                    `<span class="wr-volume-icon" title="${esc(word('wrVolume'))}">&#128264;</span>` +
                    '<input type="range" min="0" max="100" step="1" class="wr-volume-slider">' +
                    '<span class="wr-volume-value"></span>' +
                    '</div>' +
                    `<div class="wr-grid" style="grid-template-columns:repeat(${opts.columns},minmax(0,1fr))"></div>` +
                    '</div>',
            );
            const $root = $div.find('.wr-root');
            $root.find('.wr-now').toggle(opts.showTitle);
            $root.find('.wr-volume').toggle(opts.showVolume);

            const listIds = [`${inst}.info.stations`, `${inst}.info.targets`];
            let stations = [];
            let targets = [];
            let target = '';
            /** @type {Array<[string, Function]>} */
            const bound = [];
            const playerId = key => `${inst}.targets.${target}.${key}`;

            const bind = (id, handler) => {
                if (!vis.editMode && vis.states && typeof vis.states.bind === 'function') {
                    vis.states.bind(`${id}.val`, handler);
                    bound.push([id, handler]);
                }
            };
            const unbind = keep => {
                for (let i = bound.length - 1; i >= 0; i--) {
                    if (!keep || !keep(bound[i][0])) {
                        vis.states.unbind(`${bound[i][0]}.val`, bound[i][1]);
                        bound.splice(i, 1);
                    }
                }
            };

            /**
             * @param {JQuery} $box - Element for the image
             * @param {any} station - Entry of info.stations
             */
            const putLogo = ($box, station) => {
                const sources = logoSources(station);
                $box.empty();
                if (!sources.length) {
                    $box.append(`<span class="wr-initial">${esc(String(station?.name || '?').charAt(0))}</span>`);
                    return;
                }
                const img = new Image();
                img.alt = station.name || '';
                let i = 0;
                img.onerror = () => {
                    i++;
                    if (i < sources.length) {
                        img.src = sources[i];
                    } else {
                        $(img).replaceWith(
                            `<span class="wr-initial">${esc(String(station.name || '?').charAt(0))}</span>`,
                        );
                    }
                };
                img.src = sources[0];
                $box.append(img);
            };

            const drawPlayers = () => {
                const $sel = $root.find('.wr-player');
                const $name = $root.find('.wr-player-name');
                if (fixed) {
                    $sel.hide();
                    const t = targets.find(x => x.id === target);
                    $name.show().text(t ? t.name : `${word('wrNoPlayer')}: ${fixed}`);
                    return;
                }
                $name.hide();
                $sel.show().html(
                    targets
                        .map(
                            t =>
                                `<option value="${esc(t.id)}"${t.id === target ? ' selected' : ''}>${esc(t.name)}</option>`,
                        )
                        .join(''),
                );
            };

            const drawGrid = () => {
                const $grid = $root.find('.wr-grid').empty();
                if (!stations.length) {
                    $grid.append(`<div class="wr-empty">${esc(word('wrNoStations'))}</div>`);
                    return;
                }
                for (const s of stations) {
                    const $tile = $(
                        `<button type="button" class="wr-tile" data-station="${esc(s.id)}" title="${esc(s.name)}">` +
                            '<div class="wr-tile-logo"></div>' +
                            (opts.showNames ? `<div class="wr-tile-name">${esc(s.name)}</div>` : '') +
                            '</button>',
                    );
                    putLogo($tile.find('.wr-tile-logo'), s);
                    $grid.append($tile);
                }
            };

            const drawNow = () => {
                const playing =
                    !!target && (valueOf(playerId('playing')) === true || valueOf(playerId('playing')) === 'true');
                const stationId = target ? String(valueOf(playerId('station')) || '') : '';
                const station = stations.find(s => s.id === stationId);
                $root.find('.wr-tile').each(function () {
                    $(this).toggleClass('wr-active', playing && $(this).attr('data-station') === stationId);
                });
                $root.toggleClass('wr-playing', playing);
                const $logo = $root.find('.wr-now-logo');
                if (playing && station) {
                    if ($logo.attr('data-station') !== station.id) {
                        putLogo($logo, station);
                        $logo.attr('data-station', station.id);
                    }
                    $root.find('.wr-now-station').text(station.name);
                    $root.find('.wr-now-title').text(String(valueOf(playerId('title')) || ''));
                } else {
                    $logo.empty().attr('data-station', '');
                    $root.find('.wr-now-station').text(word('wrNothing'));
                    $root.find('.wr-now-title').text('');
                }
                const $slider = $root.find('.wr-volume-slider');
                if (!$slider.is(':focus') && !$slider.data('dragging')) {
                    const vol = volumeOf(valueOf(playerId('volume')));
                    $slider.val(vol);
                    $root.find('.wr-volume-value').text(target ? `${vol}%` : '');
                }
                const left = target ? Number(valueOf(playerId('sleepLeft'))) || 0 : 0;
                $root.toggleClass('wr-sleeping', left > 0);
                $root.find('.wr-sleep-left').text(left > 0 ? ` ${left}` : '');
                $root.find('.wr-sleep').prop('disabled', !target || !playing);
                const alarm = target ? String(valueOf(playerId('alarmTime')) || '') : '';
                $root.toggleClass('wr-alarm-on', !!alarm);
                $root.find('.wr-alarm-time').text(alarm ? ` ${alarm}` : '');
                $root.find('.wr-alarm').prop('disabled', !target);
                const next = target ? String(valueOf(playerId('alarmNext')) || '') : '';
                const when = next ? new Date(next) : null;
                $root
                    .find('.wr-alarm-next')
                    .text(
                        when && !isNaN(when.getTime())
                            ? `${word('wrAlarmNext')}: ${when.toLocaleString(visLang(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
                            : '',
                    );
                $root.find('.wr-resume').toggle(!playing);
                $root.find('.wr-stop, .wr-volume-slider, .wr-prev, .wr-next, .wr-resume').prop('disabled', !target);
            };

            const followPlayer = () => {
                unbind(id => listIds.includes(id));
                if (!target) {
                    drawNow();
                    return;
                }
                const ids = [
                    'station',
                    'playing',
                    'title',
                    'volume',
                    'sleep',
                    'sleepLeft',
                    'alarmTime',
                    'alarmDays',
                    'alarmStation',
                    'alarmNext',
                ].map(playerId);
                load(ids, () => {
                    ids.forEach(id => bind(id, drawNow));
                    drawNow();
                });
            };

            const readLists = () => {
                stations = parseList(valueOf(listIds[0]));
                const before = target;
                targets = parseList(valueOf(listIds[1]));
                target = pickTarget(targets, fixed, target || memory.get(wid));
                drawPlayers();
                drawGrid();
                if (target !== before) {
                    followPlayer();
                } else {
                    drawNow();
                }
            };

            load(listIds, () => {
                listIds.forEach(id => bind(id, readLists));
                readLists();
            });

            if (!vis.editMode) {
                $root.on('change', '.wr-player', function () {
                    target = String($(this).val() || '');
                    memory.set(wid, target);
                    followPlayer();
                });
                $root.on('click', '.wr-tile', function () {
                    if (target) {
                        vis.setValue(playerId('station'), $(this).attr('data-station'));
                    }
                });
                $root.on('click', '.wr-stop', () => target && vis.setValue(playerId('stop'), true));
                $root.on('click', '.wr-prev', () => target && vis.setValue(playerId('prev'), true));
                $root.on('click', '.wr-next', () => target && vis.setValue(playerId('next'), true));
                $root.on('click', '.wr-resume', () => target && vis.setValue(playerId('resume'), true));
                const $panel = $root.find('.wr-alarm-panel');
                // the panel shows the alarm of the player as it is; the changes go out with Save
                const openAlarm = () => {
                    const time = String(valueOf(playerId('alarmTime')) || '');
                    $panel.find('.wr-alarm-input').val(time || '07:00');
                    const ticks = daysToTicks(valueOf(playerId('alarmDays')));
                    $panel.find('.wr-day').each(function (i) {
                        $(this).toggleClass('wr-on', ticks[i]);
                    });
                    const $sel = $panel.find('.wr-alarm-station').empty();
                    $sel.append($('<option>').val('').text(word('wrAlarmLast')));
                    for (const st of stations) {
                        $sel.append($('<option>').val(st.id).text(st.name));
                    }
                    $sel.val(String(valueOf(playerId('alarmStation')) || ''));
                    $panel.show();
                };
                $root.on('click', '.wr-alarm', () => target && ($panel.is(':visible') ? $panel.hide() : openAlarm()));
                $root.on('click', '.wr-alarm-close', () => $panel.hide());
                $root.on('click', '.wr-day', function () {
                    $(this).toggleClass('wr-on');
                });
                $root.on('click', '.wr-alarm-save', () => {
                    if (!target) {
                        return;
                    }
                    const ticks = $panel
                        .find('.wr-day')
                        .map(function () {
                            return $(this).hasClass('wr-on');
                        })
                        .get();
                    // days and station first: the time plans the alarm with them
                    vis.setValue(playerId('alarmDays'), ticksToDays(ticks));
                    vis.setValue(playerId('alarmStation'), String($panel.find('.wr-alarm-station').val() || ''));
                    vis.setValue(playerId('alarmTime'), String($panel.find('.wr-alarm-input').val() || ''));
                    $panel.hide();
                });
                $root.on('click', '.wr-alarm-off', () => {
                    if (target) {
                        vis.setValue(playerId('alarmTime'), '');
                    }
                    $panel.hide();
                });
                $root.on('click', '.wr-sleep', () => {
                    if (target) {
                        vis.setValue(playerId('sleep'), nextSleep(valueOf(playerId('sleep'))));
                    }
                });
                $root.on('input', '.wr-volume-slider', function () {
                    $(this).data('dragging', true);
                    $root.find('.wr-volume-value').text(`${$(this).val()}%`);
                });
                $root.on('change', '.wr-volume-slider', function () {
                    $(this).data('dragging', false);
                    if (target) {
                        vis.setValue(playerId('volume'), Number($(this).val()));
                    }
                });
            }

            $div.data('destroy', () => {
                unbind();
                $root.off();
            });
        },
    };
})();
