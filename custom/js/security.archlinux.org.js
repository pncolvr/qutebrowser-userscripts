// ==UserScript==
// @name         archlinux.org
// @namespace    http://archlinux.org/
// @version      0.1
// @description  security.archlinux.org
// @author       pncolvr
// @match        https://security.archlinux.org/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    function setImportantStyles(selector, styles) {
        document.querySelectorAll(selector).forEach((element) => {
            Object.entries(styles).forEach(([property, value]) => {
                element.style.setProperty(property, value, 'important');
            });
        });
    }

    setImportantStyles('div#archnavbar', {
        'min-height': '20px',
        'height': '20px'
    });

    setImportantStyles('div#archnavbarlogo, div#archnavbar > div#logo', {
        'display': 'none'
    });
    
    setImportantStyles('#archnavbar, #archnavbarmenu', {
        'padding': '0',
        'border-bottom': 'none'
    });

    setImportantStyles('#archnavbar ul li, #archnavbarmenu ul li', {
        'line-height': '20px',
        'padding-top': '0',
        'padding-bottom': '0'
    });
 })();