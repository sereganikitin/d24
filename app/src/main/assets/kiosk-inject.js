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
        var all = document.querySelectorAll('h1,h2,h3,h4,h5,span,div,p,a,button');
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
            var input = scope.querySelector('input');
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
                    // Дата визита намеренно не трогаем в этой версии — по
                    // умолчанию форма и так подставляет сегодняшнюю дату,
                    // а сам инпут даты, похоже, открывает календарь-виджет,
                    // который безопаснее не автоматизировать вслепую.
                }, 250);
            }, 250);
        }, 350);
    }

    window.__ds24Voice = {
        fillCarPass: fillCarPass,
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
