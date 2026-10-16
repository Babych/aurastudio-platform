// AuraStudio Frontend Client Application Logic

        lucide.createIcons();

        // App State
        let currentUser = JSON.parse(localStorage.getItem('aurastudio_user') || 'null');
        function getGuestUserId() {
            let gid = localStorage.getItem('aura_guest_id');
            if (!gid) {
                gid = 'guest_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
                localStorage.setItem('aura_guest_id', gid);
            }
            return gid;
        }
        let currentStudioMode = 'photo';
        let currentLang = 'en';
        let attachedFileBase64 = null;
        let selectedPresetId = null;
        let telegramPollInterval = null;
        let currentRating = 5;
        let cachedUserHistory = null;

        function formatImgSrc(src, id) {
            if (!src) return id ? `/api/image/${id}.png` : '';
            if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/')) {
                return src;
            }
            if (src.startsWith('/9j/')) return `data:image/jpeg;base64,${src}`;
            if (src.startsWith('iVBOR')) return `data:image/png;base64,${src}`;
            return `data:image/jpeg;base64,${src}`;
        }

        // Multilingual Translations
        const TRANSLATIONS = {
            en: {
                nav_catalog: "Styles",
                nav_telemetry: "Live Stats",
                btn_pro: "Upgrade",
                btn_login: "Sign In",
                tab_photo_studio: "Photo Studio",
                greeting_title: "What would you like to create?",
                greeting_subtitle: "Describe any image to generate with Qwen 2.1, or attach a photo to edit styles.",
                prompt_placeholder: "Describe an image to generate from scratch, or attach a photo to edit styles (type '/' for presets)...",
                btn_attach: "Attach Photo",
                btn_styles: "Presets",
                btn_generate: "Generate",
                msg_photo_ready: "Photo attached & ready"
            },
            uk: {
                nav_catalog: "Каталог",
                nav_telemetry: "Моніторинг",
                btn_pro: "Підписка",
                btn_login: "Увійти",
                tab_photo_studio: "Фото-студія",
                greeting_title: "Що ви хочете створити сьогодні?",
                greeting_subtitle: "Опишіть картинку для генерації з нуля на базі Qwen 2.1 або додайте фото для стилізації.",
                prompt_placeholder: "Опишіть зображення для генерації з нуля, або прикріпіть фото (натисніть '/' для пресетів)...",
                btn_attach: "Додати фото",
                btn_styles: "Пресети",
                btn_generate: "Згенерувати",
                msg_photo_ready: "Фото прикріплено"
            }
        };

        // Initialize App & Auth
        function initApp() {
            checkUserAuthUI();
            setupDragAndDrop();
            setupClipboardPaste();
            loadPublicConfig();
            checkAndRestoreActiveTask();
        }

        async function loadPublicConfig() {
            try {
                const res = await fetch('/api/config');
                const data = await res.json();
                if (data.status === 'success') {
                    window.aurastudioConfig = data;
                    if (data.google_client_id) {
                        const el = document.getElementById('g_id_onload');
                        if (el) el.setAttribute('data-client_id', data.google_client_id);
                        if (window.google && window.google.accounts && window.google.accounts.id) {
                            window.google.accounts.id.initialize({
                                client_id: data.google_client_id,
                                callback: handleGoogleCredentialResponse
                            });
                            window.google.accounts.id.renderButton(
                                document.getElementById('googleAuthContainer'),
                                { theme: 'outline', size: 'large', width: 280 }
                            );
                        }
                    }
                    checkUserAuthUI();
                }
            } catch(e) {}
        }

        function checkUserAuthUI() {
            const loginBtn = document.getElementById('loginNavBtn');
            const userBadge = document.getElementById('userBadge');
            const nameLabel = document.getElementById('userNameLabel');
            const avatarLetter = document.getElementById('userAvatarLetter');
            const telemetryNavBtn = document.getElementById('telemetryNavBtn');
            const telemetryFooterBtn = document.getElementById('telemetryFooterBtn');

            const isAdmin = currentUser && (
                currentUser.is_admin === true || 
                currentUser.role === 'admin' ||
                currentUser.email?.includes('babych') ||
                currentUser.email?.includes('memory1024') ||
                currentUser.username === 'lame618' ||
                currentUser.username === 'memory1024' ||
                currentUser.username === 'Dmytro' ||
                currentUser.id === 'tg_1359272262' ||
                currentUser.id?.includes('112903967526802503571') ||
                localStorage.getItem('aurastudio_admin_token')
            );


            if (telemetryNavBtn) {
                if (isAdmin) {
                    telemetryNavBtn.classList.remove('hidden');
                    telemetryNavBtn.classList.add('flex');
                } else {
                    telemetryNavBtn.classList.add('hidden');
                    telemetryNavBtn.classList.remove('flex');
                }
            }

            if (telemetryFooterBtn) {
                if (isAdmin) {
                    telemetryFooterBtn.classList.remove('hidden');
                    telemetryFooterBtn.classList.add('inline-block');
                } else {
                    telemetryFooterBtn.classList.add('hidden');
                    telemetryFooterBtn.classList.remove('inline-block');
                }
            }

            const starsBadge = document.getElementById('userStarsBadge');
            const starsAmount = document.getElementById('userStarsAmount');

            if (currentUser && currentUser.id) {
                loginBtn.classList.add('hidden');
                userBadge.classList.remove('hidden');
                userBadge.classList.add('flex');
                nameLabel.innerText = currentUser.name || currentUser.username || 'User';
                avatarLetter.innerText = ((currentUser.name || currentUser.username || 'U')[0]).toUpperCase();

                // Fetch real-time Stars balance & quota from API
                fetch(`/api/user/profile?user_id=${currentUser.id}`)
                    .then(r => r.json())
                    .then(data => {
                        if (data.status === 'success') {
                            const stars = (data.stars_balance !== undefined ? data.stars_balance : (data.user && data.user.stars_balance)) || 0;
                            if (starsAmount) starsAmount.innerText = stars;
                            if (starsBadge) {
                                starsBadge.classList.remove('hidden');
                                starsBadge.classList.add('flex');
                            }
                            const hint = document.getElementById('promptCounterHint');
                            if (hint) {
                                if (data.is_admin) {
                                    hint.innerText = '👑 Admin Pro (Unlimited)';
                                } else if (data.subscription) {
                                    hint.innerText = 'Unlimited Pro';
                                } else if (data.free_remaining > 0) {
                                    hint.innerText = `${data.free_remaining}/${data.daily_limit || 5} Free Daily`;
                                } else {
                                    hint.innerText = `0/${data.daily_limit || 5} Free (⭐️ 10 Stars)`;
                                }
                            }
                            const planEl = document.getElementById('userModalPlan');
                            if (planEl) {
                                if (data.is_admin) {
                                    planEl.innerText = '👑 Admin Access (Unlimited)';
                                } else if (data.subscription) {
                                    planEl.innerText = `Pro (${data.subscription.plan_tier.toUpperCase()})`;
                                } else {
                                    planEl.innerText = `Free Tier (${data.free_remaining !== undefined ? data.free_remaining : 5}/${data.daily_limit || 5} Free Daily)`;
                                }
                            }
                            if (data.history) {
                                cachedUserHistory = data.history;
                                renderStreamHistory(data.history);
                                renderUserModalHistory(data.history);
                            }
                        }
                    }).catch(() => {});
            } else {
                loginBtn.classList.remove('hidden');
                userBadge.classList.add('hidden');
                userBadge.classList.remove('flex');
                if (starsBadge) {
                    starsBadge.classList.add('hidden');
                    starsBadge.classList.remove('flex');
                }
                const guestId = getGuestUserId();
                fetch(`/api/user/profile?user_id=${encodeURIComponent(guestId)}`)
                    .then(r => r.json())
                    .then(data => {
                        const hint = document.getElementById('promptCounterHint');
                        if (hint) {
                            if (data.free_remaining > 0) {
                                hint.innerText = currentLang === 'uk' ? '1 Безкоштовна проба' : '1 Free Trial';
                            } else {
                                hint.innerText = currentLang === 'uk' ? 'Увійдіть для 5/день' : 'Sign In for 5 Free';
                            }
                        }
                        if (data.history && data.history.length > 0) {
                            cachedUserHistory = data.history;
                            renderStreamHistory(data.history);
                        }
                    }).catch(() => {
                        const hint = document.getElementById('promptCounterHint');
                        if (hint) hint.innerText = currentLang === 'uk' ? '1 Безкоштовна проба' : '1 Free Trial';
                    });
            }
        }

        // Language Toggle
        function toggleLanguage() {
            currentLang = currentLang === 'en' ? 'uk' : 'en';
            document.getElementById('langFlag').innerText = currentLang === 'en' ? '🇺🇸' : '🇺🇦';
            document.getElementById('langLabel').innerText = currentLang.toUpperCase();
            
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (TRANSLATIONS[currentLang][key]) {
                    el.innerHTML = TRANSLATIONS[currentLang][key];
                }
            });

            const promptInput = document.getElementById('mainPromptInput');
            if (promptInput) {
                promptInput.setAttribute('placeholder', TRANSLATIONS[currentLang].prompt_placeholder);
            }
        }

        // Prompt Input & Slash Palette Logic
        function handlePromptInput(e) {
            const val = e.target.value;
            // Auto expand textarea height
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 240) + 'px';

            // Check if slash typed
            if (val.endsWith('/') || val === '/') {
                showSlashMenu();
            } else if (!val.includes('/')) {
                hideSlashMenu();
            }
        }

        function handlePromptKeydown(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                hideSlashMenu();
                triggerGeneration();
            }
        }

        // Global Escape Listener: Closes modals, slash menu, or active preset
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const slashMenu = document.getElementById('slashMenu');
                if (slashMenu && !slashMenu.classList.contains('hidden')) {
                    hideSlashMenu();
                    return;
                }

                // Close any open modals
                const modals = ['authModal', 'paywallModal', 'catalogModal', 'userModal', 'feedbackModal', 'fullImageModal'];
                let modalClosed = false;
                for (const modalId of modals) {
                    const el = document.getElementById(modalId);
                    if (el && !el.classList.contains('hidden')) {
                        el.classList.add('hidden');
                        el.classList.remove('flex');
                        modalClosed = true;
                    }
                }
                if (modalClosed) return;

                // If a preset is active, clear it
                if (selectedPresetId) {
                    clearActivePreset();
                }
            }
        });

        function showSlashMenu() {
            document.getElementById('slashMenu').classList.remove('hidden');
        }

        function hideSlashMenu() {
            document.getElementById('slashMenu').classList.add('hidden');
        }

        function toggleSlashMenu() {
            const menu = document.getElementById('slashMenu');
            menu.classList.toggle('hidden');
        }

        function applySlashPreset(presetId, commandTag, promptInstruction) {
            selectedPresetId = presetId;
            const input = document.getElementById('mainPromptInput');
            input.value = promptInstruction;
            
            // Show active preset badge with close button
            const pill = document.getElementById('activePresetPill');
            const pillLabel = document.getElementById('activePresetPillLabel');
            if (pill && pillLabel) {
                pillLabel.innerText = commandTag;
                pill.classList.remove('hidden');
                pill.classList.add('flex');
                if (window.lucide) lucide.createIcons();
            }

            hideSlashMenu();
            input.focus();
        }

        function clearActivePreset() {
            selectedPresetId = null;
            const pill = document.getElementById('activePresetPill');
            if (pill) {
                pill.classList.add('hidden');
                pill.classList.remove('flex');
            }
            const input = document.getElementById('mainPromptInput');
            if (input) {
                input.value = '';
            }
        }


        // Attachment & Drag and Drop Handling
        function handleFileInput(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                attachedFileBase64 = e.target.result;
                document.getElementById('attachedThumbImg').src = attachedFileBase64;
                document.getElementById('attachedFileName').innerText = file.name || 'photo.jpg';
                document.getElementById('attachedImagePreviewBox').classList.remove('hidden');
                document.getElementById('attachedImagePreviewBox').classList.add('flex');
            };
            reader.readAsDataURL(file);
        }

        function clearAttachedImage() {
            attachedFileBase64 = null;
            document.getElementById('attachedThumbImg').src = '';
            document.getElementById('mainFileInput').value = '';
            document.getElementById('attachedImagePreviewBox').classList.add('hidden');
            document.getElementById('attachedImagePreviewBox').classList.remove('flex');
        }

        function setupDragAndDrop() {
            const dropZone = document.getElementById('dropZone');
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
                dropZone.addEventListener(evt, e => {
                    e.preventDefault();
                    e.stopPropagation();
                }, false);
            });

            ['dragenter', 'dragover'].forEach(evt => {
                dropZone.addEventListener(evt, () => {
                    dropZone.classList.add('border-indigo-500', 'ring-2', 'ring-indigo-500/20');
                }, false);
            });

            ['dragleave', 'drop'].forEach(evt => {
                dropZone.addEventListener(evt, () => {
                    dropZone.classList.remove('border-indigo-500', 'ring-2', 'ring-indigo-500/20');
                }, false);
            });

            dropZone.addEventListener('drop', e => {
                const dt = e.dataTransfer;
                const files = dt.files;
                if (files && files.length > 0) {
                    handleFileInput(files[0]);
                }
            }, false);
        }

        function setupClipboardPaste() {
            window.addEventListener('paste', e => {
                const items = (e.clipboardData || e.originalEvent.clipboardData).items;
                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== -1) {
                        const blob = items[i].getAsFile();
                        handleFileInput(blob);
                        break;
                    }
                }
            });
        }

        let loadingTimerInterval = null;
        let generationStartTimestamp = 0;

        function startIntelligentLoadingHUD(hasPhoto, initialEta = 22, initialQueuePos = 1, isWarm = true) {
            generationStartTimestamp = Date.now();
            const statusEl = document.getElementById('loadingStatusText');
            const subEl = document.getElementById('loadingSubText');
            const pBar = document.getElementById('loadingProgressBar');
            const pText = document.getElementById('loadingPercentText');
            const elapsedEl = document.getElementById('loadingElapsedSec');
            const etaEl = document.getElementById('loadingEtaSec');
            const queueBadge = document.getElementById('loadingQueueBadge');
            const queueDot = document.getElementById('loadingQueueDot');
            const queueText = document.getElementById('loadingQueueText');

            if (etaEl) etaEl.innerText = `~${initialEta}s`;
            if (elapsedEl) elapsedEl.innerText = '0s';

            if (!isWarm) {
                if (queueBadge) {
                    queueBadge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-sky-50 text-sky-800 border border-sky-200 shadow-xs';
                }
                if (queueDot) queueDot.className = 'w-2 h-2 rounded-full bg-sky-400';
                if (queueText) queueText.innerText = currentLang === 'uk' ? '⚡ Прогрів GPU кластера (~75с)' : '⚡ GPU Cold Start (~75s)';
                if (statusEl) statusEl.innerText = currentLang === 'uk' ? '⚡ Пробуджуємо Nvidia L40S GPU...' : '⚡ Waking up Nvidia L40S GPU...';
                if (subEl) subEl.innerText = currentLang === 'uk' ? 'Перший запуск після простою: завантажуємо 20B модель у VRAM. Наступні — 22с!' : 'First run after idle: loading 20B model weights into VRAM. Subsequent runs take 22s!';
            } else if (initialQueuePos > 1) {
                if (queueBadge) {
                    queueBadge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-800 border border-indigo-200 shadow-xs';
                }
                if (queueDot) queueDot.className = 'w-2 h-2 rounded-full bg-indigo-500';
                if (queueText) queueText.innerText = currentLang === 'uk' ? `Позиція в черзі: #${initialQueuePos}` : `Queue Position: #${initialQueuePos}`;
            } else {
                if (queueBadge) {
                    queueBadge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-xs';
                }
                if (queueDot) queueDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
                if (queueText) queueText.innerText = currentLang === 'uk' ? '🟢 Гарячий GPU • Обробка' : '🟢 Hot GPU Slot • Ready (~22s)';
            }

            pBar.style.width = '15%';
            if (pText) pText.innerText = '15%';

            let currentProgress = 15;

            if (loadingTimerInterval) clearInterval(loadingTimerInterval);
            loadingTimerInterval = setInterval(() => {
                const elapsed = Math.floor((Date.now() - generationStartTimestamp) / 1000);
                if (elapsedEl) elapsedEl.innerText = `${elapsed}s`;

                // Progress curve
                if (!isWarm) {
                    const maxExpected = initialEta || 78;
                    currentProgress = Math.min(96, Math.max(15, (elapsed / maxExpected) * 94));
                } else {
                    if (elapsed <= 5) {
                        currentProgress = Math.min(35, 15 + elapsed * 4);
                    } else if (elapsed <= 18) {
                        currentProgress = Math.min(75, 35 + (elapsed - 5) * 3);
                    } else if (elapsed <= 25) {
                        currentProgress = Math.min(88, 75 + (elapsed - 18) * 1.8);
                    } else {
                        currentProgress = Math.min(96, 88 + (elapsed - 25) * 0.25);
                    }
                }
                if (pBar) pBar.style.width = `${Math.round(currentProgress)}%`;
                if (pText) pText.innerText = `${Math.round(currentProgress)}%`;

                // Cold Start specific stages and transition to Active Cluster
                if (!isWarm) {
                    if (elapsed < 35) {
                        statusEl.innerText = currentLang === 'uk' ? '⚡ Пробуджуємо Nvidia L40S GPU...' : '⚡ Initializing GPU Cluster...';
                        subEl.innerText = currentLang === 'uk' ? 'Завантаження 15.2GB вагів Qwen 2.5 DiT у 48GB VRAM...' : 'Allocating 48GB VRAM & mounting 15.2GB Qwen 2.5 DiT weights...';
                    } else if (elapsed < 50) {
                        statusEl.innerText = currentLang === 'uk' ? '✨ Запуск середовища дифузії...' : '✨ Starting Diffusion Environment...';
                        subEl.innerText = currentLang === 'uk' ? 'Кластер майже готовий! Починаємо трансформацію...' : 'Cluster warming up! Executing diffusion pipeline...';
                    } else {
                        // After 50s, GPU has booted up and is running diffusion!
                        if (queueBadge && queueText) {
                            queueBadge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-xs';
                            if (queueDot) queueDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
                            queueText.innerText = currentLang === 'uk' ? '🟢 Кластер активний • Дифузія' : '🟢 Cluster Active • Diffusion Running';
                        }
                        if (hasPhoto) {
                            statusEl.innerText = currentLang === 'uk' ? '💎 Синтез реалістичної текстури та шкіри...' : '💎 Synthesizing Realistic Skin & Textures...';
                            subEl.innerText = currentLang === 'uk' ? 'Рендеринг природних мікро-пор, тонкого волосся та підповерхневого розсіювання' : 'Rendering authentic micro-pores, peach fuzz hair & subsurface scattering';
                        } else {
                            statusEl.innerText = currentLang === 'uk' ? '✨ Генерація високої деталізації з Qwen 2.1...' : '✨ High-Fidelity Diffusion with Qwen 2.1...';
                            subEl.innerText = currentLang === 'uk' ? 'Синтез фотореалістичного освітлення та деталей' : 'Synthesizing photorealistic illumination and depth of field';
                        }
                    }
                } else {
                    // Dynamic Intelligent Stages for warm inference
                    if (hasPhoto) {
                        if (elapsed < 6) {
                            statusEl.innerText = currentLang === 'uk' ? '🔒 Фіксуємо 100% рис обличчя...' : '🔒 Preserving 100% Facial Identity...';
                            subEl.innerText = currentLang === 'uk' ? 'Зберігаємо анатомію очей, погляд, міміку та освітлення' : 'Locking facial contours, gaze, expression & natural lighting';
                        } else if (elapsed < 16) {
                            statusEl.innerText = currentLang === 'uk' ? '✨ Запуск моделі Qwen 2.5 DiT (6-Bit Master)...' : '✨ Qwen 2.5 DiT Latent Diffusion Running...';
                            subEl.innerText = currentLang === 'uk' ? 'Обробка 20B мультимодальних параметрів на Nvidia L40S GPU' : 'Executing 20B multi-modal diffusion on Nvidia L40S 48GB GPU';
                        } else if (elapsed < 26) {
                            statusEl.innerText = currentLang === 'uk' ? '💎 Синтез реалістичної текстури та шкіри...' : '💎 Synthesizing Realistic Skin & Textures...';
                            subEl.innerText = currentLang === 'uk' ? 'Рендеринг природних мікро-пор, тонкого волосся та підповерхневого розсіювання' : 'Rendering authentic micro-pores, peach fuzz hair & subsurface scattering';
                        } else if (elapsed < 45) {
                            statusEl.innerText = currentLang === 'uk' ? '⚡ Пікове навантаження кластера — фіналізація...' : '⚡ GPU Cluster Peak Demand — Finalizing...';
                            subEl.innerText = currentLang === 'uk' ? 'Виділено додатковий обчислювальний потік для завершення рендеру' : 'High GPU demand detected. Compute stream allocated, finishing render...';
                            if (queueBadge && queueText) {
                                queueBadge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 shadow-xs';
                                queueText.innerText = currentLang === 'uk' ? 'Пріоритетне виконання' : 'Priority Execution';
                            }
                        } else {
                            statusEl.innerText = currentLang === 'uk' ? '🚀 Фінальне декодування VAE...' : '🚀 Finalizing Neural Latent Decoding...';
                            subEl.innerText = currentLang === 'uk' ? 'Збираємо 8K зображення без стиснення. Майже готово!' : 'Assembling full uncompressed master render. Almost ready!';
                        }
                    } else {
                        if (elapsed < 8) {
                            statusEl.innerText = currentLang === 'uk' ? '🎨 Аналізуємо текстовий опис сцени...' : '🎨 Analyzing Text Prompt & Scene...';
                            subEl.innerText = currentLang === 'uk' ? 'Створення латентного простору композиції' : 'Building multi-modal latent composition space';
                        } else if (elapsed < 20) {
                            statusEl.innerText = currentLang === 'uk' ? '✨ Генерація високої деталізації з Qwen 2.1...' : '✨ High-Fidelity Diffusion with Qwen 2.1...';
                            subEl.innerText = currentLang === 'uk' ? 'Синтез фотореалістичного освітлення та деталей' : 'Synthesizing photorealistic illumination and depth of field';
                        } else {
                            statusEl.innerText = currentLang === 'uk' ? '💎 Завершення рендерингу...' : '💎 Finalizing Generation Output...';
                            subEl.innerText = currentLang === 'uk' ? 'Декодування нейромережевих тензорів' : 'Decoding neural latent tensors to high-res image';
                        }
                    }
                }

                // Sync with chat stream live card
                const liveBadge = document.getElementById('liveStatusBadge');
                const liveSubtext = document.getElementById('liveStatusSubtext');
                const liveBar = document.getElementById('liveStatusBar');
                const pendingBadge = document.getElementById('pendingElapsedBadge');
                const liveDot = document.getElementById('liveStatusDot');

                if (liveBadge && statusEl) liveBadge.innerText = statusEl.innerText.replace(/[🔒✨💎⚡🚀🎨🟢]/g, '').trim();
                if (liveSubtext && subEl) liveSubtext.innerText = subEl.innerText;
                if (liveBar) liveBar.style.width = `${Math.round(currentProgress)}%`;
                if (pendingBadge) {
                    pendingBadge.innerText = `${elapsed}s elapsed`;
                }
                if (liveDot) {
                    liveDot.className = (!isWarm && elapsed < 50) ? "w-2 h-2 rounded-full bg-sky-400 animate-pulse" : "w-2 h-2 rounded-full bg-emerald-500 animate-pulse";
                }
            }, 1000);
        }

        function stopIntelligentLoadingHUD() {
            if (loadingTimerInterval) {
                clearInterval(loadingTimerInterval);
                loadingTimerInterval = null;
            }
        }

        function setGenerateBtnLoading(isLoading) {
            const btn = document.getElementById('generateBtn');
            if (!btn) return;
            btn.disabled = isLoading;
            if (isLoading) {
                btn.innerHTML = `
                    <div class="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    <span>${currentLang === 'uk' ? 'Генеруємо...' : 'Generating...'}</span>
                `;
                btn.classList.add('opacity-75', 'cursor-not-allowed');
            } else {
                btn.innerHTML = `
                    <span data-i18n="btn_generate">${currentLang === 'uk' ? 'Згенерувати' : 'Generate'}</span>
                    <i data-lucide="arrow-up" class="w-4 h-4"></i>
                `;
                btn.classList.remove('opacity-75', 'cursor-not-allowed');
                if (window.lucide) lucide.createIcons();
            }
        }

        // Trigger AI Generation (Supports both Image-to-Image and Text-to-Image with Qwen 2.1 DiT)
        async function triggerGeneration() {
            const promptInput = document.getElementById('mainPromptInput');
            const prompt = (promptInput ? promptInput.value : '').trim();
            if (!prompt) {
                alert(currentLang === 'uk' ? 'Будь ласка, напишіть опис або виберіть стиль через /.' : 'Please enter a prompt or pick a style using /.');
                return;
            }

            // 1. Immediately dismiss mobile keyboard so the viewport unfreezes and can scroll
            if (promptInput) {
                promptInput.blur();
            }

            const hasPhoto = !!attachedFileBase64;
            const inputPhotoBase64 = attachedFileBase64;

            // 2. Synchronously create active task (0ms delay, no blocking network calls!)
            const taskId = `task_${Date.now().toString().slice(-6)}_${Math.random().toString(36).substring(2, 6)}`;
            const activeTask = {
                taskId,
                prompt,
                presetId: selectedPresetId || (hasPhoto ? 'custom' : 'text_to_image'),
                hasPhoto,
                inputImage: inputPhotoBase64 || null,
                startedAt: Date.now(),
                etaSec: 160
            };
            localStorage.setItem('aura_active_task', JSON.stringify(activeTask));

            // 3. Immediately render user's sent message bubble & live AI progress card in stream
            renderPendingStreamCard(activeTask);

            // 4. Now safely clear composer input and image preview
            if (promptInput) {
                promptInput.value = '';
                promptInput.style.height = 'auto';
            }
            attachedFileBase64 = null;
            const attachedBox = document.getElementById('attachedImagePreviewBox');
            if (attachedBox) {
                attachedBox.classList.add('hidden');
                attachedBox.classList.remove('flex');
            }
            const fileInput = document.getElementById('mainFileInput');
            if (fileInput) fileInput.value = '';

            // 5. Update generate button with active spinner
            setGenerateBtnLoading(true);

            // 6. Hide previous results canvas
            const resCanvas = document.getElementById('resultCanvasBox');
            if (resCanvas) resCanvas.classList.add('hidden');
            const topLoadingBox = document.getElementById('generationLoadingBox');
            if (topLoadingBox) topLoadingBox.classList.add('hidden');

            // 7. Smoothly scroll directly to the pending stream card after mobile keyboard dismisses
            setTimeout(() => {
                const pendingBox = document.getElementById('streamPendingBox');
                if (pendingBox) {
                    pendingBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 80);

            // 8. Start polling loop immediately
            pollActiveTask(activeTask);

            // 9. Fetch live queue & warm status in background to update ETA badge dynamically
            fetch('/api/queue-status').then(r => r.json()).then(qData => {
                if (qData.estimated_seconds) activeTask.etaSec = qData.estimated_seconds;
                if (typeof qData.is_warm === 'boolean') activeTask.isWarm = qData.is_warm;
            }).catch(() => {});

            // 10. Dispatch task to Cloudflare Worker & GPU Cluster
            try {
                const effectiveUserId = (currentUser && currentUser.id) ? currentUser.id : getGuestUserId();
                const res = await fetch('/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        task_id: taskId,
                        image_base64: inputPhotoBase64 || null,
                        prompt: prompt,
                        preset_id: selectedPresetId || (hasPhoto ? 'custom' : 'text_to_image'),
                        user_id: effectiveUserId,
                        user_email: currentUser ? currentUser.email : null,
                        user_name: currentUser ? currentUser.name : 'Guest User'
                    })
                });

                const data = await res.json();

                if (data.status === 'queued' || data.status === 'processing') {
                    // Task accepted and dispatched to Modal GPU in background. Polling loop takes full control!
                    console.log('[*] Task successfully queued on GPU cluster:', data.task_id);
                } else if (data.status === 'success') {
                    if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
                    localStorage.removeItem('aura_active_task');
                    clearPendingStreamCard();
                    showResult(data, inputPhotoBase64);
                    refreshStreamHistory();
                    setGenerateBtnLoading(false);
                } else if (data.status === 'daily_limit_reached') {
                    if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
                    localStorage.removeItem('aura_active_task');
                    renderFailedStreamCard(activeTask, data.message || 'Daily free limit reached.');
                    openPaywall();
                    setGenerateBtnLoading(false);
                } else if (data.status === 'auth_required') {
                    if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
                    localStorage.removeItem('aura_active_task');
                    renderFailedStreamCard(activeTask, data.message || 'Authentication required.');
                    openAuthModal();
                    setGenerateBtnLoading(false);
                } else {
                    if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
                    localStorage.removeItem('aura_active_task');
                    renderFailedStreamCard(activeTask, data.message || 'Generation failed on GPU cluster.');
                    setGenerateBtnLoading(false);
                }
            } catch(e) {
                console.error('Direct fetch error, background polling will continue if task registered:', e);
            }
        }

        function showResult(data, inputPhoto) {
            const hasInput = !!inputPhoto || !!attachedFileBase64;
            const inputCol = document.getElementById('resultInputCol');
            const resultGrid = document.getElementById('resultGrid');

            if (inputCol) {
                if (hasInput) {
                    inputCol.classList.remove('hidden');
                    document.getElementById('resultInputImg').src = inputPhoto || attachedFileBase64;
                    if (resultGrid) {
                        resultGrid.className = 'grid grid-cols-1 sm:grid-cols-2 gap-4 items-start';
                    }
                } else {
                    inputCol.classList.add('hidden');
                    if (resultGrid) {
                        resultGrid.className = 'grid grid-cols-1 max-w-lg mx-auto gap-4';
                    }
                }
            }

            document.getElementById('resultOutputImg').src = data.result_base64;
            document.getElementById('downloadResultBtn').href = data.result_base64;
            document.getElementById('resultDurationTag').innerText = (data.duration_seconds || 22.4) + 's';

            const isT2I = data.mode === 'text_to_image' || !hasInput;
            document.getElementById('resultPresetTag').innerText = isT2I
                ? '✨ Qwen 2.1 Text-to-Image'
                : (selectedPresetId || 'Custom Style').replace(/_/g, ' ').toUpperCase();

            if (data.twitter_intent_url) {
                document.getElementById('shareTwitterBtn').href = data.twitter_intent_url;
            }

            if (data.free_remaining !== undefined) {
                const hint = document.getElementById('promptCounterHint');
                if (hint) {
                    if (data.free_remaining >= 999) {
                        hint.innerText = '👑 Admin Pro (Unlimited)';
                    } else {
                        hint.innerText = data.free_remaining > 0 ? `${data.free_remaining}/${data.daily_limit || 5} Free Daily` : `0/${data.daily_limit || 5} Free (⭐️ 10 Stars)`;
                    }
                }
            }

            currentShareUrl = data.share_url;
            if (window.lucide) lucide.createIcons();

            document.getElementById('resultCanvasBox').classList.remove('hidden');
            document.getElementById('resultCanvasBox').scrollIntoView({ behavior: 'smooth' });
        }

        let currentShareUrl = null;

        function copyCurrentShareLink() {
            if (!currentShareUrl) return;
            navigator.clipboard.writeText(currentShareUrl).then(() => {
                const label = document.getElementById('copyShareLinkText');
                if (label) {
                    const original = label.innerText;
                    label.innerText = currentLang === 'uk' ? 'Скопійовано! ✓' : 'Copied! ✓';
                    setTimeout(() => { label.innerText = original; }, 2000);
                }
            }).catch(() => {
                prompt(currentLang === 'uk' ? 'Посилання на результат:' : 'Share link:', currentShareUrl);
            });
        }

        function resetForNewPrompt() {
            document.getElementById('mainPromptInput').focus();
            document.getElementById('mainPromptInput').select();
            document.getElementById('dropZone').scrollIntoView({ behavior: 'smooth' });
        }

        // Studio Stream & History Feed State
        let streamItems = [];
        let pollingInterval = null;

        function escapeHtml(str) {
            if (!str) return '';
            return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function escapeJs(str) {
            if (!str) return '';
            return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, ' ');
        }

        function reusePrompt(promptText) {
            const input = document.getElementById('mainPromptInput');
            if (input) {
                input.value = promptText;
                input.focus();
                document.getElementById('photoStudioBox').scrollIntoView({ behavior: 'smooth' });
            }
        }

        function refreshStreamHistory() {
            const uid = (currentUser && currentUser.id) ? currentUser.id : getGuestUserId();
            fetch(`/api/user/profile?user_id=${encodeURIComponent(uid)}`)
                .then(r => r.json())
                .then(data => {
                    if (data.status === 'success' && data.history) {
                        cachedUserHistory = data.history;
                        renderStreamHistory(data.history);
                        if (currentUser) renderUserModalHistory(data.history);
                    }
                    const hint = document.getElementById('promptCounterHint');
                    if (hint && !currentUser) {
                        if (data.free_remaining > 0) {
                            hint.innerText = currentLang === 'uk' ? '1 Безкоштовна проба' : '1 Free Trial';
                        } else {
                            hint.innerText = currentLang === 'uk' ? 'Увійдіть для 5/день' : 'Sign In for 5 Free';
                        }
                    }
                }).catch(() => {});
        }

        function renderStreamHistory(history) {
            streamItems = history || [];
            const list = document.getElementById('streamItemsList');
            const badge = document.getElementById('streamCountBadge');
            if (badge) badge.innerText = streamItems.length;

            if (!list) return;

            const validStream = (streamItems || []).filter(g => g.output_image_url || (g.status === 'SUCCESS' && g.input_image_url));

            if (!validStream.length) {
                list.innerHTML = `
                    <div id="streamEmptyState" class="text-center py-8 text-slate-400 text-xs">
                        Your generated photos and transformations will appear here in your stream.
                    </div>
                `;
                return;
            }

            list.innerHTML = validStream.map(g => {
                const outImg = formatImgSrc(g.output_image_url, g.id);
                const inImg = g.input_image_url && g.input_image_url !== 'uploaded_image' ? formatImgSrc(g.input_image_url) : null;
                const imgSrc = outImg || inImg;
                const inSrc = inImg;
                const shareUrl = `/s/${g.share_token || g.id}`;
                const presetName = (g.preset_id || 'Photo').replace(/_/g, ' ').toUpperCase();
                const durText = g.duration_seconds ? `${parseFloat(g.duration_seconds).toFixed(1)}s` : '';
                const userAvatarLetter = currentUser ? ((currentUser.name || currentUser.username || 'U')[0]).toUpperCase() : 'U';

                return `
                <div class="space-y-4 pt-2">
                    <!-- Turn 1: User Request Message Bubble (Right Aligned like ChatGPT) -->
                    <div class="flex items-start justify-end gap-3 max-w-xl ml-auto">
                        <div class="bg-indigo-600 text-white rounded-3xl rounded-tr-sm px-4 py-3 shadow-md space-y-2 text-right">
                            ${inSrc ? `
                                <div class="rounded-xl overflow-hidden border border-indigo-400/40 w-24 h-24 ml-auto mb-1 bg-indigo-950/60 flex items-center justify-center">
                                    <img src="${inSrc}" class="w-full h-full object-contain">
                                </div>
                            ` : ''}
                            <p class="text-xs sm:text-sm font-medium leading-relaxed">${escapeHtml(g.prompt)}</p>
                            <span class="text-[10px] text-indigo-200 font-mono block">${g.created_at || 'Recently'}</span>
                        </div>
                        <div class="w-8 h-8 rounded-2xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs shrink-0 border border-indigo-200 shadow-sm mt-0.5">
                            ${userAvatarLetter}
                        </div>
                    </div>

                    <!-- Turn 2: AI Assistant Response (Left Aligned like ChatGPT) -->
                    <div class="flex items-start gap-3 max-w-2xl mr-auto">
                        <div class="w-8 h-8 rounded-2xl bg-gradient-to-tr from-indigo-600 to-cyan-500 text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-md shadow-indigo-500/20 mt-0.5">
                            <i data-lucide="sparkles" class="w-4 h-4"></i>
                        </div>
                        <div class="bg-white rounded-3xl rounded-tl-sm p-5 border border-slate-200/90 shadow-sm space-y-4 hover:border-indigo-200 transition flex-1">
                            <div class="flex items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                                <div class="flex items-center gap-2">
                                    <span class="text-xs font-bold text-slate-900">${presetName}</span>
                                    <span class="text-[9px] bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full font-bold">Qwen 2.5 DiT 20B</span>
                                </div>
                                <div class="flex items-center gap-2">
                                    ${durText ? `<span class="text-[10px] text-slate-400 font-mono">${durText}</span>` : ''}
                                    <button onclick="reusePrompt('${escapeJs(g.prompt)}')" class="px-2 py-1 rounded-xl bg-slate-50 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 text-xs font-medium transition flex items-center gap-1 border border-slate-200" title="Remix Prompt">
                                        <i data-lucide="corner-up-left" class="w-3 h-3"></i>
                                        <span class="hidden sm:inline">Remix</span>
                                    </button>
                                </div>
                            </div>

                            <div class="grid grid-cols-1 ${inSrc ? 'sm:grid-cols-2' : 'max-w-md mx-auto'} gap-3 items-center">
                                ${inSrc ? `
                                <div class="space-y-1">
                                    <span class="text-[11px] font-semibold text-slate-400 px-1">Original Input</span>
                                    <div class="rounded-2xl overflow-hidden bg-slate-900 border border-slate-200 min-h-[220px] max-h-[460px] flex items-center justify-center">
                                        <img src="${inSrc}" class="w-full h-auto max-h-[460px] object-contain">
                                    </div>
                                </div>
                                ` : ''}
                                <div class="space-y-1">
                                    <span class="text-[11px] font-semibold text-indigo-600 px-1 flex items-center justify-between">
                                        <span>✨ Master Render</span>
                                        <span class="text-[9px] bg-indigo-50 border border-indigo-200 px-1.5 py-0.2 rounded font-bold">8K HD</span>
                                    </span>
                                    <div class="rounded-2xl overflow-hidden bg-slate-900 border border-indigo-200 min-h-[220px] max-h-[460px] flex items-center justify-center group relative cursor-pointer" onclick="openFullImageModalWithSrc('${imgSrc}')">
                                        <img src="${imgSrc}" class="w-full h-auto max-h-[460px] object-contain group-hover:scale-102 transition duration-300">
                                        <div class="absolute inset-0 bg-slate-900/30 opacity-0 group-hover:opacity-100 transition flex items-center justify-center rounded-2xl">
                                            <span class="text-xs text-white font-medium bg-slate-900/75 px-3 py-1.5 rounded-xl backdrop-blur">Click to Expand</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
                                <span class="text-slate-400 font-mono text-[11px]">AuraStudio AI</span>
                                <div class="flex items-center gap-2">
                                    <a href="${shareUrl}" target="_blank" class="px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium transition flex items-center gap-1.5">
                                        <i data-lucide="share-2" class="w-3.5 h-3.5"></i>
                                        <span>Share</span>
                                    </a>
                                    <a href="${imgSrc}" download="AuraStudio_${g.id}.png" class="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold transition flex items-center gap-1.5 shadow-sm">
                                        <i data-lucide="download" class="w-3.5 h-3.5"></i>
                                        <span>Download</span>
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                `;
            }).join('');

            if (window.lucide) lucide.createIcons();
        }

        function renderPendingStreamCard(activeTask) {
            const pendingBox = document.getElementById('streamPendingBox');
            if (!pendingBox) return;

            const emptyState = document.getElementById('streamEmptyState');
            if (emptyState) emptyState.classList.add('hidden');

            const presetName = (activeTask.presetId || 'Transformation').replace(/_/g, ' ').toUpperCase();
            const userAvatarLetter = currentUser ? ((currentUser.name || currentUser.username || 'U')[0]).toUpperCase() : 'U';
            const inPhoto = activeTask.inputImage;

            pendingBox.innerHTML = `
                <div class="space-y-4">
                    <!-- User Sent Message Bubble in Chat Stream -->
                    <div class="flex items-start justify-end gap-3 max-w-xl ml-auto">
                        <div class="bg-indigo-600 text-white rounded-3xl rounded-tr-sm px-4 py-3 shadow-md space-y-2 text-right">
                            ${inPhoto ? `
                                <div class="rounded-xl overflow-hidden border border-indigo-400/40 w-24 h-24 ml-auto mb-1 bg-indigo-950/60 flex items-center justify-center">
                                    <img src="${inPhoto}" class="w-full h-full object-contain">
                                </div>
                            ` : ''}
                            <p class="text-xs sm:text-sm font-medium leading-relaxed">${escapeHtml(activeTask.prompt)}</p>
                            <span class="text-[10px] text-indigo-200 font-mono block">Just now</span>
                        </div>
                        <div class="w-8 h-8 rounded-2xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs shrink-0 border border-indigo-200 shadow-sm mt-0.5">
                            ${userAvatarLetter}
                        </div>
                    </div>

                    <!-- Live AI Assistant Status Card in Chat Stream -->
                    <div id="liveAiStatusCard" class="bg-white rounded-3xl p-5 border-2 border-indigo-200/90 shadow-md space-y-4 max-w-xl mr-auto">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div id="liveStatusIconBox" class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-cyan-500 text-white flex items-center justify-center shadow-md shadow-indigo-500/20 shy-breathe shrink-0">
                                    <i data-lucide="sparkles" class="w-5 h-5"></i>
                                </div>
                                <div>
                                    <div class="flex items-center gap-2">
                                        <span class="text-xs font-bold text-indigo-950">${presetName}</span>
                                        <span id="liveStatusDot" class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                                        <span id="liveStatusBadge" class="text-[10px] text-amber-700 font-bold bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">Starting...</span>
                                    </div>
                                    <p id="liveStatusSubtext" class="text-[11px] text-slate-500">Connecting to Nvidia L40S GPU cluster...</p>
                                </div>
                            </div>
                            <span id="pendingElapsedBadge" class="text-xs font-mono font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-3 py-1 rounded-full">
                                0s elapsed
                            </span>
                        </div>

                        <!-- Progress Bar -->
                        <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                            <div id="liveStatusBar" class="bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-500 h-1.5 rounded-full transition-all duration-300" style="width: 15%;"></div>
                        </div>
                    </div>
                </div>
            `;
            pendingBox.classList.remove('hidden');
            if (window.lucide) lucide.createIcons();
        }

        function renderFailedStreamCard(activeTask, errorMsg) {
            const pendingBox = document.getElementById('streamPendingBox');
            if (!pendingBox) return;

            const emptyState = document.getElementById('streamEmptyState');
            if (emptyState) emptyState.classList.add('hidden');

            const presetName = (activeTask.presetId || 'Transformation').replace(/_/g, ' ').toUpperCase();
            const userAvatarLetter = currentUser ? ((currentUser.name || currentUser.username || 'U')[0]).toUpperCase() : 'U';
            const inPhoto = activeTask.inputImage;

            pendingBox.innerHTML = `
                <div class="space-y-4">
                    <!-- User Sent Message Bubble -->
                    <div class="flex items-start justify-end gap-3 max-w-xl ml-auto">
                        <div class="bg-indigo-600 text-white rounded-3xl rounded-tr-sm px-4 py-3 shadow-md space-y-2 text-right">
                            ${inPhoto ? `
                                <div class="rounded-xl overflow-hidden border border-indigo-400/40 w-24 h-24 ml-auto mb-1 bg-indigo-950/30">
                                    <img src="${inPhoto}" class="w-full h-full object-cover">
                                </div>
                            ` : ''}
                            <p class="text-xs sm:text-sm font-medium leading-relaxed">${escapeHtml(activeTask.prompt)}</p>
                            <span class="text-[10px] text-indigo-200 font-mono block">Failed generation</span>
                        </div>
                        <div class="w-8 h-8 rounded-2xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs shrink-0 border border-indigo-200 shadow-sm mt-0.5">
                            ${userAvatarLetter}
                        </div>
                    </div>

                    <!-- Failed AI Assistant Card -->
                    <div class="bg-red-50/90 rounded-3xl p-5 border-2 border-red-200 shadow-md space-y-3 max-w-xl mr-auto">
                        <div class="flex items-start justify-between gap-3">
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-2xl bg-red-600 text-white flex items-center justify-center shadow-md shadow-red-500/20 shrink-0 mt-0.5">
                                    <i data-lucide="alert-circle" class="w-5 h-5"></i>
                                </div>
                                <div class="space-y-1">
                                    <div class="flex items-center gap-2">
                                        <span class="text-xs font-bold text-red-950">${presetName}</span>
                                        <span class="text-[10px] text-red-700 font-bold bg-red-100 border border-red-300 px-2 py-0.5 rounded-full">Failed</span>
                                    </div>
                                    <p class="text-xs text-red-700 font-medium leading-relaxed">${escapeHtml(errorMsg || 'GPU request timed out or was interrupted.')}</p>
                                </div>
                            </div>
                            <button onclick="reusePrompt('${escapeJs(activeTask.prompt)}')" class="px-3 py-1.5 rounded-xl bg-white hover:bg-red-100 text-red-700 text-xs font-bold transition flex items-center gap-1.5 shrink-0 border border-red-300 shadow-sm" title="Try Again">
                                <i data-lucide="rotate-cw" class="w-3.5 h-3.5"></i>
                                <span>Try Again</span>
                            </button>
                        </div>
                    </div>
                </div>
            `;
            pendingBox.classList.remove('hidden');
            if (window.lucide) lucide.createIcons();
            pendingBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        function clearPendingStreamCard() {
            const pendingBox = document.getElementById('streamPendingBox');
            if (pendingBox) {
                pendingBox.innerHTML = '';
                pendingBox.classList.add('hidden');
            }
            const emptyState = document.getElementById('streamEmptyState');
            if (emptyState && (!cachedUserHistory || cachedUserHistory.length === 0)) {
                emptyState.classList.remove('hidden');
            }
        }

        function checkAndRestoreActiveTask() {
            const raw = localStorage.getItem('aura_active_task');
            if (!raw) return;

            let activeTask;
            try {
                activeTask = JSON.parse(raw);
            } catch(e) {
                localStorage.removeItem('aura_active_task');
                return;
            }

            if (!activeTask || !activeTask.taskId) {
                localStorage.removeItem('aura_active_task');
                return;
            }

            // If task is older than 5 minutes, assume expired
            const ageMs = Date.now() - (activeTask.startedAt || 0);
            if (ageMs > 300000) {
                localStorage.removeItem('aura_active_task');
                return;
            }

            renderPendingStreamCard(activeTask);
            pollActiveTask(activeTask);
        }

        function pollActiveTask(activeTask) {
            if (pollingInterval) clearInterval(pollingInterval);

            const badge = document.getElementById('pendingElapsedBadge');
            const liveBadge = document.getElementById('liveStatusBadge');
            const liveSubtext = document.getElementById('liveStatusSubtext');
            const liveBar = document.getElementById('liveStatusBar');
            const liveDot = document.getElementById('liveStatusDot');
            let pollCount = 0;

            pollingInterval = setInterval(async () => {
                pollCount++;
                const elapsedSec = Math.floor((Date.now() - activeTask.startedAt) / 1000);
                if (badge) badge.innerText = `${elapsedSec}s elapsed`;

                const isCold = activeTask.etaSec > 40;
                // Honest, granular stage updates in chat based on cold vs warm
                if (isCold) {
                    if (elapsedSec < 35) {
                        if (liveBadge) liveBadge.innerText = '⚡ GPU Cold Start...';
                        if (liveSubtext) liveSubtext.innerText = 'Allocating Nvidia L40S GPU & mounting storage...';
                        if (liveBar) liveBar.style.width = `${Math.min(30, 5 + elapsedSec * 0.8)}%`;
                        if (liveDot) liveDot.className = 'w-2 h-2 rounded-full bg-sky-400 animate-pulse';
                    } else if (elapsedSec < 90) {
                        if (liveBadge) liveBadge.innerText = '⚡ Loading 15.2GB DiT...';
                        if (liveSubtext) liveSubtext.innerText = 'Streaming Q6_K master weights into 48GB VRAM...';
                        if (liveBar) liveBar.style.width = `${Math.min(65, 30 + (elapsedSec - 35) * 0.6)}%`;
                        if (liveDot) liveDot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
                    } else if (elapsedSec < 135) {
                        if (liveBadge) liveBadge.innerText = '🎨 Neural Diffusion...';
                        if (liveSubtext) liveSubtext.innerText = 'Executing 22-step DiT latent transformation...';
                        if (liveBar) liveBar.style.width = `${Math.min(88, 65 + (elapsedSec - 90) * 0.5)}%`;
                        if (liveDot) liveDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
                    } else {
                        if (liveBadge) liveBadge.innerText = '✨ Finalizing Master 8K...';
                        if (liveSubtext) liveSubtext.innerText = 'Decoding high-resolution VAE latents into photo...';
                        if (liveBar) liveBar.style.width = '95%';
                        if (liveDot) liveDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
                    }
                } else {
                    if (elapsedSec < 4) {
                        if (liveBadge) liveBadge.innerText = '🟢 Warm GPU Ready...';
                        if (liveSubtext) liveSubtext.innerText = 'Connected to hot Nvidia L40S slot...';
                        if (liveBar) liveBar.style.width = '25%';
                        if (liveDot) liveDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
                    } else if (elapsedSec < 20) {
                        if (liveBadge) liveBadge.innerText = '🎨 Neural Diffusion...';
                        if (liveSubtext) liveSubtext.innerText = 'Executing 22-step DiT latent transformation...';
                        if (liveBar) liveBar.style.width = `${Math.min(85, 25 + (elapsedSec - 4) * 3.8)}%`;
                        if (liveDot) liveDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
                    } else {
                        if (liveBadge) liveBadge.innerText = '✨ Finalizing...';
                        if (liveSubtext) liveSubtext.innerText = 'Decoding master latents into 8K photo...';
                        if (liveBar) liveBar.style.width = '95%';
                        if (liveDot) liveDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
                    }
                }

                try {
                    const res = await fetch(`/api/task-status/${activeTask.taskId}`);
                    if (res.ok) {
                        const data = await res.json();
                        if (data.status === 'success') {
                            clearInterval(pollingInterval);
                            pollingInterval = null;
                            localStorage.removeItem('aura_active_task');
                            clearPendingStreamCard();
                            stopIntelligentLoadingHUD();
                            const loadingBox = document.getElementById('generationLoadingBox');
                            if (loadingBox) loadingBox.classList.add('hidden');
                            setGenerateBtnLoading(false);

                            // Show notification & refresh stream
                            showToastNotification(currentLang === 'uk' ? '✨ Генерацію відновлено! Завершено у фоновому режимі.' : '✨ Generation restored! Completed in background.');
                            refreshStreamHistory();

                            // Also display in main canvas if resultCanvasBox is available
                            if (data.output_image_url) {
                                showResult({
                                    result_base64: data.output_image_url,
                                    duration_seconds: data.duration_seconds || elapsedSec,
                                    share_url: data.share_url,
                                    mode: activeTask.hasPhoto ? 'image_to_image' : 'text_to_image'
                                });
                            }
                        } else if (data.status === 'failed') {
                            clearInterval(pollingInterval);
                            pollingInterval = null;
                            localStorage.removeItem('aura_active_task');
                            stopIntelligentLoadingHUD();
                            const loadingBox = document.getElementById('generationLoadingBox');
                            if (loadingBox) loadingBox.classList.add('hidden');
                            setGenerateBtnLoading(false);
                            renderFailedStreamCard(activeTask, data.error || 'Generation failed');
                        }
                    }
                } catch(e) {
                    console.error("Polling error:", e);
                }

                // Timeout after 5 minutes
                if (pollCount > 100) {
                    clearInterval(pollingInterval);
                    pollingInterval = null;
                    localStorage.removeItem('aura_active_task');
                    setGenerateBtnLoading(false);
                    renderFailedStreamCard(activeTask, 'Generation timed out after 5 minutes.');
                }
            }, 3000);
        }

        function showToastNotification(message) {
            const toast = document.createElement('div');
            toast.className = 'fixed bottom-6 right-6 z-50 bg-slate-900/90 backdrop-blur-md text-white text-xs font-semibold px-4 py-3 rounded-2xl shadow-2xl flex items-center gap-2.5 transition transform translate-y-4 opacity-0 border border-slate-700/60';
            toast.innerHTML = `<i data-lucide="sparkles" class="w-4 h-4 text-cyan-400"></i><span>${message}</span>`;
            document.body.appendChild(toast);
            if (window.lucide) lucide.createIcons();

            requestAnimationFrame(() => {
                toast.classList.remove('translate-y-4', 'opacity-0');
            });

            setTimeout(() => {
                toast.classList.add('translate-y-4', 'opacity-0');
                setTimeout(() => toast.remove(), 400);
            }, 5000);
        }

        function openFullImageModalWithSrc(src) {
            if (!src) return;
            document.getElementById('fullModalImg').src = src;
            document.getElementById('fullImageModal').classList.remove('hidden');
            document.getElementById('fullImageModal').classList.add('flex');
        }

        function openFullImageModal() {
            const outSrc = document.getElementById('resultOutputImg').src;
            if (!outSrc) return;
            document.getElementById('fullModalImg').src = outSrc;
            document.getElementById('fullImageModal').classList.remove('hidden');
            document.getElementById('fullImageModal').classList.add('flex');
        }

        function closeFullImageModal() {
            document.getElementById('fullImageModal').classList.add('hidden');
            document.getElementById('fullImageModal').classList.remove('flex');
        }

        // Modals Open / Close Handlers
        function openCatalogModal() {
            document.getElementById('catalogModal').classList.remove('hidden');
            document.getElementById('catalogModal').classList.add('flex');
        }
        function closeCatalogModal() {
            document.getElementById('catalogModal').classList.add('hidden');
            document.getElementById('catalogModal').classList.remove('flex');
        }

        function openPaywall() {
            document.getElementById('paywallModal').classList.remove('hidden');
            document.getElementById('paywallModal').classList.add('flex');
        }
        function closePaywall() {
            document.getElementById('paywallModal').classList.add('hidden');
            document.getElementById('paywallModal').classList.remove('flex');
        }

        function openAuthModal() {
            document.getElementById('authModal').classList.remove('hidden');
            document.getElementById('authModal').classList.add('flex');
        }
        function closeAuthModal() {
            document.getElementById('authModal').classList.add('hidden');
            document.getElementById('authModal').classList.remove('flex');
        }

        function renderUserModalHistory(history) {
            const grid = document.getElementById('userHistoryGrid');
            if (!grid) return;

            const items = (history || []).filter(g => g.output_image_url || g.input_image_url || g.status === 'PROCESSING');
            if (!items.length) {
                grid.innerHTML = '<div class="col-span-3 text-center py-6 text-xs text-slate-400">No creations yet. Create your first portrait above!</div>';
                return;
            }

            grid.innerHTML = items.map(g => {
                const outImg = formatImgSrc(g.output_image_url, g.id);
                const inImg = formatImgSrc(g.input_image_url);
                const imgSrc = outImg || inImg;
                const shareUrl = `/s/${g.share_token || g.id}`;
                const isProcessing = g.status === 'PROCESSING';

                if (isProcessing) {
                    return `
                    <div class="relative rounded-xl overflow-hidden border border-indigo-200 bg-indigo-50/60 aspect-square shadow-sm flex flex-col items-center justify-center p-2 text-center">
                        <div class="w-6 h-6 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin mb-1.5"></div>
                        <span class="text-[10px] font-bold text-indigo-700">Processing...</span>
                    </div>`;
                }

                return `
                <div class="relative rounded-xl overflow-hidden border border-slate-200 bg-slate-50 group aspect-square shadow-sm cursor-pointer" onclick="openFullImageModalWithSrc('${imgSrc}')">
                    <img src="${imgSrc}" class="w-full h-full object-cover group-hover:scale-105 transition duration-200" loading="lazy" alt="Creation">
                    <div class="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1.5 transition p-1" onclick="event.stopPropagation()">
                        <a href="${imgSrc}" download="AuraStudio_${g.id}.png" class="p-1.5 rounded-lg bg-white/20 hover:bg-white/40 text-white transition" title="Download">
                            <i data-lucide="download" class="w-3.5 h-3.5"></i>
                        </a>
                        <a href="${shareUrl}" target="_blank" class="p-1.5 rounded-lg bg-white/20 hover:bg-white/40 text-white transition" title="Open Share Page">
                            <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                        </a>
                    </div>
                </div>`;
            }).join('');

            if (window.lucide) lucide.createIcons();
        }

        function openUserModal() {
            if (!currentUser) {
                openAuthModal();
                return;
            }
            document.getElementById('userModalName').innerText = currentUser.name || currentUser.username || 'User';
            document.getElementById('userModalAvatar').innerText = ((currentUser.name || currentUser.username || 'U')[0]).toUpperCase();
            
            // 1. Instant render from preloaded cache if available (0ms lag)
            if (cachedUserHistory && cachedUserHistory.length) {
                renderUserModalHistory(cachedUserHistory);
            } else {
                const grid = document.getElementById('userHistoryGrid');
                if (grid) {
                    grid.innerHTML = `
                        <div class="col-span-3 text-center py-6 text-xs text-slate-400 flex items-center justify-center gap-2">
                            <div class="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                            <span>Loading creations...</span>
                        </div>
                    `;
                }
            }

            // 2. Fetch fresh updates in background
            fetch(`/api/user/profile?user_id=${encodeURIComponent(currentUser.id)}`)
                .then(r => r.json())
                .then(data => {
                    if (data.status === 'success' && data.history) {
                        cachedUserHistory = data.history;
                        renderUserModalHistory(data.history);
                        renderStreamHistory(data.history);
                    }
                }).catch(() => {});

            document.getElementById('userModal').classList.remove('hidden');
            document.getElementById('userModal').classList.add('flex');
        }
        function closeUserModal() {
            document.getElementById('userModal').classList.add('hidden');
            document.getElementById('userModal').classList.remove('flex');
        }

        function openFeedbackModal() {
            document.getElementById('feedbackModal').classList.remove('hidden');
            document.getElementById('feedbackModal').classList.add('flex');
        }
        function closeFeedbackModal() {
            document.getElementById('feedbackModal').classList.add('hidden');
            document.getElementById('feedbackModal').classList.remove('flex');
        }

        function setRating(n) {
            currentRating = n;
            const starBtns = document.querySelectorAll('.star-btn');
            starBtns.forEach((btn, idx) => {
                btn.classList.toggle('text-yellow-400', idx < n);
                btn.classList.toggle('text-gray-600', idx >= n);
            });
        }

        async function submitFeedback() {
            if (!currentUser) {
                openAuthModal();
                return;
            }
            const comment = document.getElementById('feedbackComment').value.trim();
            if (!comment) return;

            try {
                await fetch('/api/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: currentUser.id,
                        user_name: currentUser.name || 'Verified Creator',
                        rating: currentRating,
                        comment: comment
                    })
                });
                alert('Thank you for your feedback!');
                closeFeedbackModal();
            } catch(e) {}
        }

        // Google & Telegram Auth Handlers
        function handleGoogleCredentialResponse(response) {
            fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ credential: response.credential })
            }).then(r => r.json()).then(data => {
                if (data.status === 'success') {
                    currentUser = data.user;
                    localStorage.setItem('aurastudio_user', JSON.stringify(currentUser));
                    closeAuthModal();
                    checkUserAuthUI();
                }
            }).catch(e => alert('Auth error: ' + e.message));
        }

        async function startTelegramLogin() {
            try {
                const res = await fetch('/api/auth/telegram-session', { method: 'POST' });
                const data = await res.json();
                if (data.status === 'success') {
                    document.getElementById('telegramQrImg').src = data.qr_url;
                    document.getElementById('telegramDirectBtn').href = data.deep_link;
                    document.getElementById('telegramQrBox').classList.remove('hidden');

                    if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
                        window.open(data.deep_link, '_blank');
                    }

                    if (telegramPollInterval) clearInterval(telegramPollInterval);
                    telegramPollInterval = setInterval(async () => {
                        try {
                            const pollRes = await fetch(`/api/auth/telegram-poll?session_code=${data.session_code}`);
                            const pollData = await pollRes.json();
                            if (pollData.status === 'success' && pollData.user) {
                                clearInterval(telegramPollInterval);
                                currentUser = pollData.user;
                                localStorage.setItem('aurastudio_user', JSON.stringify(currentUser));
                                closeAuthModal();
                                checkUserAuthUI();
                            }
                        } catch(e) {}
                    }, 1500);
                }
            } catch(e) {}
        }

        function handleLogout() {
            localStorage.removeItem('aurastudio_user');
            currentUser = null;
            closeUserModal();
            checkUserAuthUI();
        }

        // Payment Subscriptions & Telegram Stars Flow
        async function handleSubscribe(plan) {
            handleStarsPay(plan);
        }

        async function handleStarsPay(plan) {
            if (!currentUser) {
                openAuthModal();
                return;
            }
            try {
                // If running inside Telegram Mini App WebApp
                if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
                    const res = await fetch('/api/payments/create-stars-invoice', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plan_tier: plan, user_id: currentUser.id })
                    });
                    const data = await res.json();
                    if (data.invoice_url && window.Telegram.WebApp.openInvoice) {
                        window.Telegram.WebApp.openInvoice(data.invoice_url, (s) => { 
                            if (s === 'paid') {
                                location.reload(); 
                            }
                        });
                        return;
                    }
                }

                // Standard Web Browser: Open Telegram Bot Deep Link for 1-click Stars checkout
                const botName = 'thing_intellect_bot';
                const botDeepLink = `https://t.me/${botName}?start=buy_${plan || 'starter'}`;
                window.open(botDeepLink, '_blank');
            } catch(e) {
                window.open(`https://t.me/thing_intellect_bot?start=buy_${plan || 'starter'}`, '_blank');
            }
        }

        // Boot
        window.addEventListener('DOMContentLoaded', initApp);
