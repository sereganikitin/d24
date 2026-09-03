/*
 * Правки раскладки поверх lk.purehome.ru для главного экрана киоска:
 * уменьшаем картинки в блоке "Актуальное" сильнее, чем в "Услуги", чтобы
 * весь главный экран помещался без прокрутки.
 *
 * Не завязано на "css-XXXXXXX" классы MUI/emotion (они генерируются
 * заново при каждой пересборке сайта) — ищем секции по тексту заголовка
 * ("Актуальное" / "Услуги"), это гораздо стабильнее. Если вёрстка сайта
 * сильно поменяется и заголовок перестанет находиться — блок просто
 * тихо ничего не делает, страницу не ломает.
 *
 * Подбирайте heightPx под реальный планшет и правьте прямо этот файл —
 * пересборка Kotlin не нужна.
 */
(function () {
    function findSectionByHeading(text) {
        var candidates = document.querySelectorAll('h1,h2,h3,h4,h5,span,div,p');
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (el.children.length === 0 && el.textContent.trim() === text) {
                // Заголовок обычно лежит в строке "Заголовок + ссылка Все",
                // а сама строка — внутри секции вместе с сеткой карточек.
                return el.closest('section') || (el.parentElement && el.parentElement.parentElement) || el.parentElement;
            }
        }
        return null;
    }

    function shrinkImages(container, heightPx) {
        if (!container) return;
        var imgs = container.querySelectorAll('img');
        imgs.forEach(function (img) {
            img.style.setProperty('height', heightPx + 'px', 'important');
            img.style.setProperty('object-fit', 'cover', 'important');
        });
    }

    try {
        shrinkImages(findSectionByHeading('Актуальное'), 56);
        shrinkImages(findSectionByHeading('Услуги'), 92);
    } catch (e) {
        // не мешаем странице работать, даже если структура не совпала
    }
})();
