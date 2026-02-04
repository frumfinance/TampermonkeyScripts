// ==UserScript==
// @name         frum.finance YNAB Enhancements
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Export YNAB categories with annual totals and 6-month averages
// @author       https://frum.finance
// @downloadURL  https://github.com/frumfinance/YNABScripts/raw/refs/heads/main/YNAB-tampermonkey.user.js
// @updateURL    https://github.com/frumfinance/YNABScripts/raw/refs/heads/main/YNAB-tampermonkey.user.js
// @match        https://app.ynab.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        TIMEOUT_MS: 10000,
        CATEGORY_LOAD_DELAY_MS: 5,
        IGNORED_KEYWORDS: ['Credit Card', 'NoExport'],
        SELECTORS: {
            budgetRow: '.budget-table-row',
            masterCategory: '.is-master-category',
            categoryButton: '.budget-table-cell-name button',
            targetInspector: '.target-inspector',
            targetBehavior: '.target-behavior',
            targetByDate: '.target-by-date',
            targetBreakdownItem: '.target-breakdown-item',
            budgetToolbar: 'div.budget-table > div.budget-table-header > div.budget-toolbar',
            averageSpentButton: '#tk-average-months'
        }
    };

    const waitForElement = (selector, timeoutMs = CONFIG.TIMEOUT_MS) => {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) return resolve(element);

            const observer = new MutationObserver(() => {
                const found = document.querySelector(selector);
                if (found) {
                    observer.disconnect();
                    resolve(found);
                }
            });

            observer.observe(document, { childList: true, subtree: true });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Element not found: ${selector}`));
            }, timeoutMs);
        });
    };

    const downloadCSV = (rows, filename) => {
        const csvContent = "data:text/csv;charset=utf-8," +
            rows.map(row => row.map(cell => `"${cell}"`).join(",")).join("\n");

        const link = document.createElement("a");
        link.href = encodeURI(csvContent);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const formatCurrency = amount => 
        amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const stripCurrencySymbols = text => text.replace(/[₪$€£¥]/g, '');

    const containsIgnoredKeyword = name => 
        CONFIG.IGNORED_KEYWORDS.some(keyword => name.includes(keyword));

    const findCurrentBalance = inspector => {
        const items = [...inspector.querySelectorAll(CONFIG.SELECTORS.targetBreakdownItem)];
        const balanceItem = items.find(item => 
            item.querySelector('.target-breakdown-item-label')?.textContent.includes("Current Balance")
        );
        
        if (!balanceItem) return 0;
        
        const valueText = balanceItem.querySelector('.user-data.currency.tabular-nums')?.textContent;
        return valueText ? parseFloat(valueText.replace(/,/g, '')) : 0;
    };

    const extractAverageSpent = () => {
        const button = document.querySelector(CONFIG.SELECTORS.averageSpentButton);
        if (!button) return "N/A";

        const currencySpan = button.querySelector('.user-data.currency');
        if (!currencySpan) return "N/A";

        const rawText = currencySpan.textContent.trim();
        const cleaned = stripCurrencySymbols(rawText).replace(/,/g, '');
        const parsed = parseFloat(cleaned);

        return isNaN(parsed) ? "N/A" : formatCurrency(parsed);
    };

    const extractTargetDetails = () => {
        const inspector = document.querySelector(CONFIG.SELECTORS.targetInspector);
        if (!inspector) return { rawDetails: "N/A", currentBalance: 0 };

        const behavior = inspector.querySelector(CONFIG.SELECTORS.targetBehavior)?.textContent.trim() || "N/A";
        const byDate = inspector.querySelector(CONFIG.SELECTORS.targetByDate)?.textContent.trim() || "";
        
        return {
            rawDetails: `${behavior} ${byDate}`.trim(),
            currentBalance: findCurrentBalance(inspector)
        };
    };

    const parseSetAsidePattern = text => {
        const match = text.match(/Set Aside Another\s+(\d+(?:,\d{3})*(?:\.\d{2})?)\s+(Each (?:Week|Month|Year))(?:\s+By\s+(.+))?/i);
        return match ? ["Set Aside Another", match[1].replace(/,/g, ''), match[2], match[3] || "N/A"] : null;
    };

    const parseStandardPattern = text => {
        const match = text.match(/^([A-Za-z ]+?)\s+(\d+(?:,\d{3})*(?:\.\d{2})?)\s+(Each (?:Week|Month|Year))(?:\s+By\s+(.+))?$/);
        return match ? [match[1].trim(), match[2].replace(/,/g, ''), match[3], match[4] || "N/A"] : null;
    };

    const parseBalancePattern = text => {
        const match = text.match(/Have a Balance of\s+(\d+(?:,\d{3})*(?:\.\d{2})?)\s+By\s+(.+)/);
        return match ? ["Have a Balance", match[1].replace(/,/g, ''), "N/A", match[2]] : null;
    };

    const parseTargetDetails = rawDetails => {
        const cleaned = stripCurrencySymbols(rawDetails);
        
        return parseSetAsidePattern(cleaned) ||
               parseStandardPattern(cleaned) ||
               parseBalancePattern(cleaned) ||
               ["N/A", "N/A", "N/A", "N/A"];
    };

    const calculateMonthlyFromDueDate = (targetAmount, dueDate, currentBalance) => {
        const match = dueDate.match(/(\b\w+\b) (\d{4})/);
        if (!match) return null;

        const dueMonth = new Date(`${match[1]} 1, ${match[2]}`).getMonth();
        const dueYear = parseInt(match[2], 10);
        const now = new Date();
        const monthsRemaining = (dueYear - now.getFullYear()) * 12 + (dueMonth - now.getMonth());

        return monthsRemaining > 0 ? (targetAmount - currentBalance) / monthsRemaining : null;
    };

    const calculateAnnualTotal = (amount, frequency, dueDate, currentBalance) => {
        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) return "N/A";

        const frequencyMultipliers = {
            'Each Week': 52,
            'Each Month': 12,
            'Each Year': 1
        };

        if (frequency in frequencyMultipliers) {
            return formatCurrency(numericAmount * frequencyMultipliers[frequency]);
        }

        if (frequency === 'N/A' && dueDate !== "N/A") {
            const monthlyAmount = calculateMonthlyFromDueDate(numericAmount, dueDate, currentBalance);
            return monthlyAmount ? formatCurrency(monthlyAmount * 12) : "N/A";
        }

        return "N/A";
    };

    class CategoryExporter {
        constructor() {
            this.rows = [
                ["Category Group", "Category", "Target Type", "Target Amount", "Target Frequency", "Target Due Date", "Annual Total", "Avg Spent (6 Mo.)"],
                ["https://frum.finance", "Donate: https://frum.finance/donate", "", "", "", "", "", ""]
            ];
            this.currentGroup = null;
            this.groupStartRows = {};
        }

        startGroup(name) {
            if (containsIgnoredKeyword(name)) {
                this.currentGroup = null;
                return;
            }

            this.finalizeCurrentGroup();
            this.currentGroup = name;
            this.rows.push([name, "", "", "", "", "", "", ""]);
            this.groupStartRows[name] = this.rows.length + 1;
        }

        addCategory(name, targetType, targetAmount, targetFrequency, targetDueDate, annualTotal, averageSpent) {
            if (!this.currentGroup || containsIgnoredKeyword(name)) return;

            const categoryName = name.includes("Redact") ? "Redacted" : name;
            const numericAmount = parseFloat(targetAmount);
            const formattedAmount = Number.isFinite(numericAmount) ? formatCurrency(numericAmount) : "";

            this.rows.push([
                this.currentGroup,
                categoryName,
                targetType,
                formattedAmount,
                targetFrequency,
                targetDueDate,
                annualTotal,
                averageSpent
            ]);
        }

        finalizeCurrentGroup() {
            if (!this.currentGroup || !this.groupStartRows[this.currentGroup]) return;

            const startRow = this.groupStartRows[this.currentGroup];
            const endRow = this.rows.length;
            this.rows.push([
                this.currentGroup,
                "TOTAL",
                "", "", "", "",
                `=SUM(G${startRow}:G${endRow})`,
                `=SUM(H${startRow}:H${endRow})`
            ]);
        }

        addGrandTotal() {
            this.finalizeCurrentGroup();

            const groupTotalRows = this.rows
                .map((row, idx) => row[1] === "TOTAL" ? idx + 1 : null)
                .filter(Boolean);

            this.rows.push([
                "GRAND TOTAL",
                "", "", "", "", "",
                `=SUM(${groupTotalRows.map(r => `G${r}`).join(",")})`,
                `=SUM(${groupTotalRows.map(r => `H${r}`).join(",")})`
            ]);
        }

        getRows() {
            return this.rows;
        }
    }

    const processCategory = async (button, exporter) => {
        button.click();
        await new Promise(resolve => setTimeout(resolve, CONFIG.CATEGORY_LOAD_DELAY_MS));

        const { rawDetails, currentBalance } = extractTargetDetails();
        const [targetType, targetAmount, targetFrequency, targetDueDate] = parseTargetDetails(rawDetails);
        const annualTotal = calculateAnnualTotal(targetAmount, targetFrequency, targetDueDate, currentBalance);
        const averageSpent = extractAverageSpent();

        exporter.addCategory(
            button.textContent.trim(),
            targetType,
            targetAmount,
            targetFrequency,
            targetDueDate,
            annualTotal,
            averageSpent
        );
    };

    const extractBudgetData = async () => {
        const exporter = new CategoryExporter();
        const rows = document.querySelectorAll(CONFIG.SELECTORS.budgetRow);

        for (const row of rows) {
            const button = row.querySelector(CONFIG.SELECTORS.categoryButton);
            if (!button) continue;

            if (row.classList.contains(CONFIG.SELECTORS.masterCategory.slice(1))) {
                exporter.startGroup(button.textContent.trim());
            } else {
                await processCategory(button, exporter);
            }
        }

        exporter.addGrandTotal();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadCSV(exporter.getRows(), `ynab_categories_export_${timestamp}.csv`);
    };

    const createExportButton = () => {
        if (document.getElementById('ynab-export-button')) return;

        const button = document.createElement('button');
        button.id = 'ynab-export-button';
        button.textContent = "Export Categories to CSV";
        Object.assign(button.style, {
            padding: "10px 15px",
            backgroundColor: "#0079c1",
            color: "white",
            border: "none",
            borderRadius: "5px",
            cursor: "pointer",
            marginLeft: "10px"
        });
        button.onclick = extractBudgetData;

        waitForElement(CONFIG.SELECTORS.budgetToolbar)
            .then(toolbar => toolbar.appendChild(button))
            .catch(err => console.error("Failed to add export button:", err));
    };

    waitForElement(`${CONFIG.SELECTORS.budgetRow}${CONFIG.SELECTORS.masterCategory}`)
        .then(createExportButton)
        .catch(err => console.error("Failed to initialize:", err));
})();
