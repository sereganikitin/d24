/*
 * Правки раскладки/оформления поверх lk.purehome.ru под фирменный стиль
 * Pure (белый / тёплый чёрный / кофейно-коричневый) и под киоск (главный
 * экран без прокрутки, скрытые лишние опции в формах и т.п.).
 *
 * Не завязано на "css-XXXXXXX" классы MUI/emotion (они генерируются
 * заново при каждой пересборке сайта вендором) — ищем элементы по
 * тексту, который на них написан. Это медленнее для поддержки (менять
 * приходится по факту, глядя на реальные экраны), зато не ломается
 * молча при любом редизайне сайта — если текст не нашёлся, блок просто
 * ничего не делает.
 *
 * Модалки (например "Заказать пропуск") дорисовываются в DOM уже после
 * первой загрузки страницы, без полной перезагрузки — поэтому все
 * правки применяются не только один раз при старте, но и повторно при
 * любом изменении DOM (MutationObserver ниже). Это же понадобится
 * дальше для голосового помощника, который будет открывать эти модалки
 * и заполнять поля.
 *
 * Правьте прямо этот файл — пересборка Kotlin не нужна, только
 * пересборка через Codemagic/GitHub Actions (а после того, как правки
 * стали подгружаться с GitHub на лету — вообще без пересборки).
 */
(function () {
    var PURE = {
        ink: '#201B16',
        inkSoft: '#6B6156',
        surface: '#F5F1EC',
        brand: '#6B4F36',
        brandTint: '#EDE1D2',
        urgent: '#C1512E',
        urgentText: '#FFFFFF',
    };

    function findLeafByText(text) {
        // 'li' добавлен для пунктов выпадающих списков (см.
        // fillServiceAppeal ниже) — типичные кастомные select/autocomplete
        // рисуют опции как <li>текст</li> без вложенных элементов, чего не
        // было в исходном наборе тегов (кнопки/вкладки формы пропуска —
        // div/span/button).
        var all = document.querySelectorAll('h1,h2,h3,h4,h5,span,div,p,a,button,li');
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.children.length === 0 && el.textContent.trim() === text) return el;
        }
        return null;
    }

    // ---------- Главный экран: "Актуальное" мельче, чем "Услуги" ----------
    function findSectionByHeading(text) {
        var leaf = findLeafByText(text);
        if (!leaf) return null;
        return leaf.closest('section') || (leaf.parentElement && leaf.parentElement.parentElement) || leaf.parentElement;
    }

    function shrinkImages(container, heightPx) {
        if (!container) return;
        container.querySelectorAll('img').forEach(function (img) {
            img.style.setProperty('height', heightPx + 'px', 'important');
            img.style.setProperty('object-fit', 'cover', 'important');
        });
    }

    // ---------- Боковая панель: карточки + сетка быстрых действий ----------
    function closestRow(el) {
        return el.closest('button,a,[role="button"],li') || el.parentElement;
    }

    function recolorIcon(row, color) {
        var svg = row.querySelector('svg');
        if (!svg) return;
        svg.style.setProperty('color', color, 'important');
        svg.querySelectorAll('path,circle,rect').forEach(function (shape) {
            if (shape.getAttribute('stroke') && shape.getAttribute('stroke') !== 'none') {
                shape.setAttribute('stroke', color);
            }
            if (shape.getAttribute('fill') && shape.getAttribute('fill') !== 'none') {
                shape.setAttribute('fill', color);
            }
        });
        // сам бейдж-кружок/квадрат вокруг иконки — обычно ближайший div/span-родитель svg
        var badge = svg.parentElement;
        if (badge && badge !== row) {
            badge.style.setProperty('border-radius', '10px', 'important');
        }
    }

    function styleActionRow(row, bg, badgeBg, iconColor, textColor) {
        if (!row) return;
        row.style.setProperty('display', 'flex', 'important');
        row.style.setProperty('align-items', 'center', 'important');
        row.style.setProperty('gap', '12px', 'important');
        row.style.setProperty('background', bg, 'important');
        row.style.setProperty('border', 'none', 'important');
        row.style.setProperty('border-radius', '14px', 'important');
        row.style.setProperty('padding', '14px 12px', 'important');
        row.style.setProperty('margin', '0', 'important');
        row.style.setProperty('color', textColor, 'important');
        var svg = row.querySelector('svg');
        var badge = svg ? svg.parentElement : null;
        if (badge && badge !== row) {
            badge.style.setProperty('background', badgeBg, 'important');
        }
        recolorIcon(row, iconColor);
    }

    function restyleQuickActions() {
        var regularLabels = ['Показания счетчиков', 'Создать обращение', 'Смотреть камеры', 'Заказать пропуск'];
        var rows = [];
        regularLabels.forEach(function (text) {
            var row = closestRow(findLeafByText(text));
            if (row) {
                rows.push(row);
                styleActionRow(row, PURE.surface, PURE.brandTint, PURE.brand, PURE.ink);
            }
        });

        var sosRow = closestRow(findLeafByText('Экстренный вызов'));
        styleActionRow(sosRow, PURE.urgent, 'rgba(255,255,255,.2)', '#FFFFFF', PURE.urgentText);

        // Если 4 обычных пункта лежат в одном родителе вместе с "Экстренный
        // вызов" — превращаем список в сетку 2×2 (СОС на всю ширину сверху)
        // просто меняя display у общего родителя, без переноса узлов —
        // так не потеряются обработчики кликов сайта.
        if (rows.length === 4 && sosRow) {
            var parent = rows[0].parentElement;
            var sameParent = rows.every(function (r) { return r.parentElement === parent; })
                && sosRow.parentElement === parent;
            if (sameParent) {
                parent.style.setProperty('display', 'grid', 'important');
                parent.style.setProperty('grid-template-columns', '1fr 1fr', 'important');
                parent.style.setProperty('gap', '8px', 'important');
                sosRow.style.setProperty('grid-column', '1 / -1', 'important');
            }
        }
    }

    function restyleStatusCard() {
        var leaf = findLeafByText('Всё оплачено');
        if (!leaf) return;
        // Поднимаемся на уровень карточки (текст статуса + подпись "К оплате").
        var card = leaf.parentElement && leaf.parentElement.parentElement
            ? leaf.parentElement.parentElement
            : leaf.parentElement;
        if (!card) return;
        card.style.setProperty('background', PURE.surface, 'important');
        card.style.setProperty('border-radius', '14px', 'important');
        card.style.setProperty('border-left', '3px solid ' + PURE.brand, 'important');
        leaf.style.setProperty('color', PURE.ink, 'important');
    }

    // ---------- Скрытие лишнего для общего лобби-аккаунта (2026-09-12) ----------
    // Планшет в лобби залогинен под одним общим аккаунтом на всех
    // жителей — разделы "своего" профиля/транспорта/показаний тут не
    // имеют смысла. Тот же принцип, что и у hidePermanentPassOption:
    // ищем по видимому тексту, если не нашли — просто ничего не делаем,
    // остальная страница не страдает.

    // "Показания счётчиков" в левом меню быстрых действий — та же самая
    // строка, что уже используется в restyleQuickActions (сейчас она
    // выключена, но текст элемента подтверждён скриншотом 2026-09-12).
    function hideMeterReadingsAction() {
        var row = closestRow(findLeafByText('Показания счетчиков'));
        if (row) row.style.setProperty('display', 'none', 'important');
    }

    // Карточка "К оплате" / "Всё оплачено" — тот же поиск, что и в
    // restyleStatusCard (тоже выключенной), просто вместо перекраски
    // прячем целиком.
    function hidePaymentCard() {
        var leaf = findLeafByText('Всё оплачено');
        if (!leaf) return;
        var card = leaf.parentElement && leaf.parentElement.parentElement
            ? leaf.parentElement.parentElement
            : leaf.parentElement;
        if (card) card.style.setProperty('display', 'none', 'important');
    }

    // Нижняя навигация (Главное/Помещение/Обращения/Платежи/Профиль) не
    // нужна на общем лобби-аккаунте. Поднимаемся от одного известного
    // пункта вверх по дереву, пока не найдём предка, который содержит
    // ВСЕ остальные подписи панели — это и есть сама панель целиком.
    function findAncestorContainingAll(startEl, texts) {
        var node = startEl;
        for (var i = 0; i < 6 && node; i++) {
            var full = node.textContent || '';
            var hasAll = texts.every(function (t) { return full.indexOf(t) !== -1; });
            if (hasAll) return node;
            node = node.parentElement;
        }
        return null;
    }

    function hideBottomNav() {
        var home = findLeafByText('Главное');
        if (!home) return;
        var bar = findAncestorContainingAll(home, ['Помещение', 'Обращения', 'Платежи', 'Профиль']);
        if (bar) bar.style.setProperty('display', 'none', 'important');
    }

    // Иконки уведомлений/профиля справа вверху — без подписи (только
    // значки), поэтому findLeafByText тут не подходит. Best-effort по
    // распространённым aria-label/title — DOM этого места не подтверждён
    // скриншотом (иконки на фото без текста), поэтому если ни один
    // вариант не совпал, просто ничего не скрываем. Дайте знать, если на
    // устройстве не сработает — понадобится реальная разметка (DevTools),
    // фото тут не поможет.
    function findByAccessibleLabel(candidates) {
        var selector = candidates.map(function (c) {
            return '[aria-label*="' + c + '" i],[title*="' + c + '" i]';
        }).join(',');
        return document.querySelector(selector);
    }

    function hideHeaderIcons() {
        var bell = findByAccessibleLabel(['уведомлен', 'notification']);
        if (bell) clickableFrom(bell).style.setProperty('display', 'none', 'important');
        var profile = findByAccessibleLabel(['профил', 'profile', 'аккаунт', 'account']);
        if (profile) clickableFrom(profile).style.setProperty('display', 'none', 'important');
    }

    // ---------- Модалка "Заказать пропуск" → "На въезд" ----------
    // На форме есть переключатель "Срок действия": Одноразовый / Постоянный.
    // Постоянного пропуска на авто по факту быть не должно — прячем кнопку,
    // но только когда рядом реально нашёлся её парный переключатель
    // "Одноразовый" (чтобы случайно не спрятать какой-то другой,
    // не связанный с пропуском элемент с тем же словом "Постоянный").
    function hidePermanentPassOption() {
        var permanent = findLeafByText('Постоянный');
        if (!permanent) return;
        var toggle = permanent.closest('button') || permanent;
        var container = toggle.parentElement;
        if (!container) return;
        var hasOneTimeSibling = Array.prototype.some.call(container.children, function (child) {
            return child.textContent && child.textContent.trim() === 'Одноразовый';
        });
        if (hasOneTimeSibling) {
            toggle.style.setProperty('display', 'none', 'important');
        }
    }

    // ---------- Тёмная тема модалки пропуска (2026-09-13) ----------
    // Голосовой консьерж теперь полноэкранный и тёмный (см.
    // assets/concierge/index.html) — после того как форма заполнена
    // голосом, житель на секунду видит настоящий сайт, чтобы проверить
    // и нажать «Заказать». Чтобы это не выглядело как "чужой светлый
    // сайт" после тёмного консьержа, красим саму модалку в ту же
    // палитру. ВАЖНО: точный DOM этой модалки не подтверждён
    // скриншотом (в отличие от текстовых меток вроде "Госномер", уже
    // проверенных в fillCarPass) — это первый эксперимент, палитра
    // точная (взята из макета консьержа), но насколько хорошо она ляжет
    // на реальную вёрстку модалки — нужно проверить на устройстве и
    // прислать скриншот, если что-то будет выглядеть не так.
    var DARK_FORM = {
        bg: '#141416',
        card: '#1c1c1f',
        text: '#f2efe9',
        textBright: '#f7f4ee',
        accent: '#9e886f',
    };

    // Модалка — не текст, а контейнер, поэтому findLeafByText не
    // годится; ищем по НАБЛЮДАЕМОМУ поведению (fixed/absolute поверх
    // большей части экрана), а не по классам MUI/emotion — это работает
    // независимо от того, как называются классы в конкретной сборке
    // сайта.
    function findModalRootByText(text) {
        var leaf = findLeafByText(text);
        if (!leaf) return null;
        var node = leaf.parentElement;
        for (var i = 0; i < 14 && node && node !== document.body; i++) {
            var style = window.getComputedStyle(node);
            var rect = node.getBoundingClientRect();
            var coversViewport = rect.width > window.innerWidth * 0.4 && rect.height > window.innerHeight * 0.4;
            if ((style.position === 'fixed' || style.position === 'absolute') && coversViewport) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    function applyDarkFormTheme() {
        var modal = findModalRootByText('На въезд') || findModalRootByText('На вход') || findModalRootByText('Заказать пропуск');
        if (!modal) return;
        modal.style.setProperty('background', DARK_FORM.bg, 'important');
        modal.querySelectorAll('h1,h2,h3,h4,h5,h6,span,div,p,label').forEach(function (el) {
            // Текст ВНУТРИ кнопок (например подпись "Заказать") не трогаем —
            // фон кнопки мы намеренно оставляем родным/светлым (см. ниже), и
            // если перекрасить только текст в светлый, подпись сливается с
            // таким же светлым фоном и кнопка визуально исчезает. Это и
            // была причина бага "нет кнопки Заказать" на реальном устройстве.
            if (el.children.length === 0 && !el.closest('button')) {
                el.style.setProperty('color', DARK_FORM.text, 'important');
            }
        });
        modal.querySelectorAll('input, textarea').forEach(function (field) {
            field.style.setProperty('background', DARK_FORM.card, 'important');
            field.style.setProperty('color', DARK_FORM.textBright, 'important');
            field.style.setProperty('border-color', DARK_FORM.accent, 'important');
        });
        modal.querySelectorAll('button').forEach(function (btn) {
            // Фон/цвет кнопок специально не трогаем — среди них есть
            // главное действие "Заказать" с фирменным акцентом сайта,
            // затирать его не нужно, только рамка под общий тон.
            btn.style.setProperty('border-color', DARK_FORM.accent, 'important');
        });
    }

    // ---------- API для голосового помощника: window.__ds24Voice ----------
    // Открывает "Заказать пропуск → На въезд" и заполняет поля. Вызывается
    // из Android (VoiceAssistant.kt) через evaluateJavascript после того,
    // как backend вернул структурированные данные из речи жителя.
    //
    // Важно: поля формы — React-контролируемые инпуты. Просто
    // input.value = x React не увидит (его внутреннее состояние не
    // обновится) — нужно ставить значение через нативный value-setter и
    // диспатчить событие 'input', это стандартный приём для программного
    // заполнения React-форм.
    function setNativeValue(input, value) {
        if (!input) return;
        var proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clickableFrom(el) {
        if (!el) return null;
        return el.closest('button,a,[role="button"]') || el;
    }

    // Ищет поле ввода рядом с текстовой подписью (например "Госномер*"),
    // поднимаясь по родителям, т.к. label и input обычно лежат в одной
    // общей обёртке чуть выше. text сравнивается по началу строки, чтобы
    // не зависеть от "*" и прочих хвостов у подписи.
    function findInputByLabelPrefix(prefix) {
        var all = document.querySelectorAll('h1,h2,h3,h4,h5,span,div,p,label');
        var label = null;
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.children.length === 0 && el.textContent.trim().indexOf(prefix) === 0) {
                label = el;
                break;
            }
        }
        if (!label) return null;
        var scope = label.parentElement;
        for (var j = 0; j < 3 && scope; j++) {
            var input = scope.querySelector('input, textarea');
            if (input) return input;
            scope = scope.parentElement;
        }
        return null;
    }

    function fillCarPass(fields) {
        fields = fields || {};
        var orderBtn = closestRow(findLeafByText('Заказать пропуск'));
        if (!orderBtn) return;
        orderBtn.click();

        setTimeout(function () {
            var driveIn = clickableFrom(findLeafByText('На въезд'));
            if (!driveIn) return;
            driveIn.click();

            setTimeout(function () {
                if (fields.ownership === 'own') {
                    // Свой транспорт — список сохранённых машин неоднозначен
                    // (может быть несколько), выбор оставляем человеку.
                    var ownTab = clickableFrom(findLeafByText('Мой'));
                    if (ownTab) ownTab.click();
                    return;
                }
                var guestTab = clickableFrom(findLeafByText('Гостевой'));
                if (guestTab) guestTab.click();

                setTimeout(function () {
                    if (fields.plateNumber) {
                        setNativeValue(findInputByLabelPrefix('Госномер'), fields.plateNumber);
                    }
                    if (fields.guestName) {
                        setNativeValue(document.querySelector('input[placeholder="Имя и фамилия"]'), fields.guestName);
                    }
                    if (fields.carLabel) {
                        setNativeValue(findInputByLabelPrefix('Название'), fields.carLabel);
                    }
                    // В форме нет отдельного поля "номер машиноместа" —
                    // по договорённости с заказчиком (2026-09-04) кладём
                    // это в общее поле "Комментарий". Точное название
                    // поля не подтверждено скриншотом (best-effort по
                    // распространённой подписи) — если не найдётся, эта
                    // строка просто ничего не сделает, остальное
                    // заполнение не пострадает.
                    if (fields.parkingSpotNumber) {
                        var comment = findInputByLabelPrefix('Коммент');
                        if (comment) setNativeValue(comment, 'Машиноместо ' + fields.parkingSpotNumber);
                    }
                    // Дата визита намеренно не трогаем в этой версии — по
                    // умолчанию форма и так подставляет сегодняшнюю дату,
                    // а сам инпут даты, похоже, открывает календарь-виджет,
                    // который безопаснее не автоматизировать вслепую.
                }, 250);
            }, 250);
        }, 350);
    }

    // Пропуск "На вход" (пешеход, без машины) — по аналогии с fillCarPass,
    // но точная DOM-структура этого экрана не подтверждена скриншотом
    // (best-effort, 2026-09-05): предполагаем, что там тоже есть поле
    // "Имя и фамилия" гостя и общее поле "Комментарий", как на форме
    // машины. Если что-то не найдётся — просто ничего не сделает,
    // остальное заполнение не пострадает; поправить легко, без пересборки.
    function fillWalkinPass(fields) {
        fields = fields || {};
        var orderBtn = closestRow(findLeafByText('Заказать пропуск'));
        if (!orderBtn) return;
        orderBtn.click();

        setTimeout(function () {
            var walkIn = clickableFrom(findLeafByText('На вход'));
            if (!walkIn) return;
            walkIn.click();

            setTimeout(function () {
                if (fields.guestName) {
                    setNativeValue(document.querySelector('input[placeholder="Имя и фамилия"]'), fields.guestName);
                }
                if (fields.destinationApartment) {
                    var comment = findInputByLabelPrefix('Коммент');
                    if (comment) setNativeValue(comment, 'Апартамент ' + fields.destinationApartment);
                }
            }, 250);
        }, 350);
    }

    // ---------- Обращение в УК на свободную тему ("Новое обращение") ----------
    // DOM подтверждён скриншотами 2026-09-13: кнопка "Создать обращение" в
    // левом меню открывает модалку с двумя ЗАВИСИМЫМИ выпадающими
    // списками "Тема"/"Детали" (Детали наполняется после выбора Темы), а
    // после выбора обоих появляется необязательное поле "Комментарий"
    // (textarea, placeholder "Введите текст заявки, например...") и
    // необязательное вложение фото (не трогаем). И Тема, и Детали — это
    // выбор из готового списка, а не свободный текст, несмотря на
    // название задачи "на свободную тему" — свободная часть тут именно
    // комментарий (см. APPEAL_TOPICS/APPEAL_DETAILS в backend/src/prompt.js).
    //
    // Сама разметка списков (какой элемент кликабелен, чтобы открыть
    // список) НЕ подтверждена скриншотом — судя по виду (плейсхолдер
    // "Выберите из списка" + стрелка, не нативный <select>), это
    // кастомный компонент вроде MUI Select/Autocomplete, у которого
    // кликабельный триггер обычно помечен role="button"/role="combobox"/
    // aria-haspopup. Это best-effort первая версия по аналогии с
    // fillWalkinPass — если предположение не подтвердится, функция тихо
    // останавливается на том шаге, где не нашла элемент, дальше житель
    // просто доделывает форму сам, ничего не ломается.
    function findSelectTriggerByLabelPrefix(prefix) {
        var all = document.querySelectorAll('h1,h2,h3,h4,h5,span,div,p,label');
        var label = null;
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.children.length === 0 && el.textContent.trim().indexOf(prefix) === 0) {
                label = el;
                break;
            }
        }
        if (!label) return null;
        var scope = label.parentElement;
        for (var j = 0; j < 3 && scope; j++) {
            var trigger = scope.querySelector('[role="button"], [role="combobox"], [aria-haspopup]');
            if (trigger) return trigger;
            scope = scope.parentElement;
        }
        return null;
    }

    // Кликает по пункту списка с точным совпадением текста (появляется в
    // DOM уже после клика по триггеру, обычно как <li>) — true, если пункт
    // найден и клик выполнен.
    function clickOptionByText(text) {
        var leaf = findLeafByText(text);
        if (!leaf) return false;
        clickableFrom(leaf).click();
        return true;
    }

    function fillServiceAppeal(fields) {
        fields = fields || {};
        var createBtn = clickableFrom(findLeafByText('Создать обращение'));
        if (!createBtn) return;
        createBtn.click();

        setTimeout(function () {
            if (!fields.appealTopic) return;
            var themeTrigger = findSelectTriggerByLabelPrefix('Тема');
            if (!themeTrigger) return;
            themeTrigger.click();

            setTimeout(function () {
                if (!clickOptionByText(fields.appealTopic)) return;

                setTimeout(function () {
                    // Детали автовыбираем, только если backend прислал
                    // конкретный пункт (сейчас это гарантировано только
                    // для темы "Начисления и оплаты" — единственной, чей
                    // список деталей увиден целиком, см. APPEAL_DETAILS).
                    // Для остальных тем поле остаётся пустым — это
                    // единственное, что жителю нужно доделать самому.
                    if (fields.appealDetail) {
                        var detailTrigger = findSelectTriggerByLabelPrefix('Детали');
                        if (detailTrigger) {
                            detailTrigger.click();
                            setTimeout(function () {
                                clickOptionByText(fields.appealDetail);
                            }, 300);
                        }
                    }

                    if (fields.appealComment) {
                        setTimeout(function () {
                            var comment = document.querySelector('textarea[placeholder*="Введите текст заявки"]');
                            if (comment) setNativeValue(comment, fields.appealComment);
                        }, fields.appealDetail ? 600 : 250);
                    }
                }, 300);
            }, 350);
        }, 350);
    }

    window.__ds24Voice = {
        fillCarPass: fillCarPass,
        fillWalkinPass: fillWalkinPass,
        fillServiceAppeal: fillServiceAppeal,
    };

    function applyAll() {
        // Визуальные правки (размер картинок, перекраска панели) временно
        // выключены по запросу — на реальном устройстве результат вышел
        // не тот, настроим аккуратно позже. Функциональные вещи (скрытие
        // "Постоянный", API для голосового помощника) продолжают работать
        // — это не про внешний вид, а про то, что должно быть так.
        // shrinkImages(findSectionByHeading('Актуальное'), 56);
        // shrinkImages(findSectionByHeading('Услуги'), 92);
        // restyleQuickActions();
        // restyleStatusCard();
        hidePermanentPassOption();
        hideMeterReadingsAction();
        hidePaymentCard();
        hideBottomNav();
        hideHeaderIcons();
        applyDarkFormTheme();
    }

    function safeApplyAll() {
        try {
            applyAll();
        } catch (e) {
            // не мешаем странице работать, даже если что-то из структуры не совпало
        }
    }

    safeApplyAll();

    // Модалки (например "Заказать пропуск") дорисовываются в DOM позже,
    // без перезагрузки страницы — переприменяем правила при изменениях
    // DOM, с небольшим дебаунсом, чтобы не грузить страницу на каждый чих.
    var debounceTimer = null;
    var observer = new MutationObserver(function () {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(safeApplyAll, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
})();
