/*
 * 첫 화면을 그리기 전에 저장된 테마와 마지막 탭을 <html> 에 붙인다.
 * app.js 는 <body> 끝에서 돌아서, 그 전에 한 번 기본값(라이트·기록 탭)으로 그려졌다가
 * 바뀌는 깜빡임이 있었다. CSP 상 인라인 스크립트를 못 써서 작은 파일로 <head> 에 둔다.
 * 시작 탭 표시는 style.css 의 [data-start-tab] 규칙이 하고, app.js 가 탭을 켠 뒤 지운다.
 */
try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  const tab = localStorage.getItem('tab');
  if (tab) document.documentElement.dataset.startTab = tab;
} catch {
  /* 저장소를 못 쓰면 기본값으로 */
}
